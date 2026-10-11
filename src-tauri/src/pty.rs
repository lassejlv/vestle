//! Native PTY transport on libtermy's process layer (`termy_core::pty`), with raw
//! output for the web terminal and ACP. libtermy runs the child on `forkpty`,
//! reads its output on its own thread, queues bounded input, coalesces resizes
//! and reports the exit after the final output. Nothing here parses output or
//! answers terminal queries; the web terminal in the window does that.

use std::{
    io,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use termy_core::pty::{Pty as TermyPty, PtyCommand as TermyCommand, PtyDimensions, PtyExit};

pub enum TerminalLaunch {
    ShellCommand(String),
    Program { program: String, args: Vec<String> },
}

#[derive(Default)]
pub struct PtyCommand<'a> {
    pub launch: Option<&'a TerminalLaunch>,
    pub working_directory: Option<&'a str>,
    pub environment: &'a [(String, String)],
}

#[derive(Clone, Copy)]
pub struct PtySize {
    cols: u16,
    rows: u16,
}

impl PtySize {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols: cols.max(1),
            rows: rows.max(1),
        }
    }

    fn dimensions(self) -> PtyDimensions {
        PtyDimensions {
            cols: self.cols,
            rows: self.rows,
            ..PtyDimensions::default()
        }
    }
}

#[derive(Clone, Copy)]
pub struct PtyExitStatus {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Default)]
struct State {
    exited: bool,
    status: Option<PtyExitStatus>,
}

pub struct Pty {
    inner: TermyPty,
    state: Arc<Mutex<State>>,
}

impl Pty {
    pub fn spawn(
        command: PtyCommand<'_>,
        size: PtySize,
        on_output: impl FnMut(&[u8]) + Send + 'static,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> io::Result<Self> {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let (program, args) = match command.launch {
            Some(TerminalLaunch::Program { program, args }) => (program.clone(), args.clone()),
            Some(TerminalLaunch::ShellCommand(script)) => (shell, vec!["-lc".into(), script.clone()]),
            None => (shell, vec!["-l".into()]),
        };
        let working_directory = command.working_directory.map(PathBuf::from);
        if let Some(directory) = &working_directory {
            // Report a clear error instead of libtermy's generic spawn failure.
            if !directory.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "Terminal working directory does not exist",
                ));
            }
        }
        let mut environment = vec![
            ("TERM".into(), "xterm-256color".into()),
            ("COLORTERM".into(), "truecolor".into()),
            ("TERM_PROGRAM".into(), "vestle".into()),
            ("TERM_PROGRAM_VERSION".into(), env!("CARGO_PKG_VERSION").into()),
            ("PATH".into(), crate::shell_env::login_path().into()),
        ];
        environment.extend(command.environment.iter().cloned());

        let state = Arc::new(Mutex::new(State::default()));
        let exit_state = state.clone();
        let inner = TermyPty::spawn(
            TermyCommand {
                program,
                args,
                working_directory,
                environment,
                inherit_environment: true,
            },
            size.dimensions(),
            on_output,
            move |exit: PtyExit| {
                // Recorded before the callback, so the status is ready when it runs.
                if let Ok(mut state) = exit_state.lock() {
                    state.exited = true;
                    state.status = Some(PtyExitStatus {
                        code: exit.code.and_then(|code| i32::try_from(code).ok()),
                        signal: exit.signal,
                    });
                }
                on_exit();
            },
        )?;
        Ok(Self { inner, state })
    }

    /// Queues input. Fails with `WouldBlock` when libtermy's 8 MiB backlog is full,
    /// and once the program has exited.
    pub fn write_owned(&self, bytes: Vec<u8>) -> io::Result<()> {
        self.inner.write(&bytes)
    }

    pub fn resize(&self, size: PtySize) -> io::Result<()> {
        self.inner.resize(size.dimensions())
    }

    pub fn exit_status(&self) -> Option<PtyExitStatus> {
        self.state.lock().ok()?.status
    }

    /// Kills the program and everything it started.
    pub fn kill(&self) -> io::Result<()> {
        let state = self.state.lock().map_err(|_| io::Error::other("PTY state poisoned"))?;
        if state.exited {
            return Ok(());
        }
        // forkpty made the child a session and process group leader, so this also
        // reaches commands it started. The exit flag is set under this lock, so the
        // group is only signalled before the exit was reported.
        // SAFETY: plain signal delivery to a process group id we own.
        unsafe {
            libc::kill(-(self.inner.pid() as i32), libc::SIGKILL);
        }
        self.inner.signal(libc::SIGKILL)
    }
}

// Dropping the libtermy PTY hangs up the session: SIGHUP to the process group,
// then SIGKILL if it is still running 250 ms later.

#[cfg(test)]
mod tests;
