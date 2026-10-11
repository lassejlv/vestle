//! Alacritty's native PTY transport, with raw output for xterm.js and ACP.
//! A single worker owns the child, drains output before reporting its status,
//! and keeps writes bounded while allowing resize and shutdown under backpressure.

use std::{
    collections::VecDeque,
    io::{self, Read, Write},
    os::unix::process::ExitStatusExt,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};

use alacritty_terminal::{
    event::{OnResize, WindowSize},
    tty::{self, ChildEvent, EventedPty, EventedReadWrite, Options, Shell},
};
use polling::{Event, Events, PollMode, Poller};

const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
const IO_BUDGET: usize = 256 * 1024;

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

    fn window_size(self) -> WindowSize {
        WindowSize {
            num_cols: self.cols,
            num_lines: self.rows,
            cell_width: 0,
            cell_height: 0,
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
    input: VecDeque<Vec<u8>>,
    input_bytes: usize,
    resize: Option<PtySize>,
    kill: bool,
    exited: bool,
    status: Option<PtyExitStatus>,
}

pub struct Pty {
    state: Arc<Mutex<State>>,
    poll: Arc<Poller>,
    child_pid: i32,
}

impl Pty {
    pub fn spawn(
        command: PtyCommand<'_>,
        size: PtySize,
        on_output: impl FnMut(&[u8]) + Send + 'static,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> io::Result<Self> {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let shell = match command.launch {
            Some(TerminalLaunch::Program { program, args }) => {
                Shell::new(program.clone(), args.clone())
            }
            Some(TerminalLaunch::ShellCommand(script)) => {
                Shell::new(shell, vec!["-lc".into(), script.clone()])
            }
            None => Shell::new(shell, vec!["-l".into()]),
        };
        let working_directory = command.working_directory.map(PathBuf::from);
        if let Some(directory) = &working_directory {
            // Alacritty ignores a failed chdir; do not silently run agent commands elsewhere.
            if !directory.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "Terminal working directory does not exist",
                ));
            }
        }
        let mut env = std::collections::HashMap::from([
            ("TERM".into(), "xterm-256color".into()),
            ("COLORTERM".into(), "truecolor".into()),
            ("TERM_PROGRAM".into(), "termy-code".into()),
            (
                "TERM_PROGRAM_VERSION".into(),
                env!("CARGO_PKG_VERSION").into(),
            ),
            ("PATH".into(), crate::shell_env::login_path().into()),
        ]);
        env.extend(command.environment.iter().cloned());
        let options = Options {
            shell: Some(shell),
            working_directory,
            env,
            drain_on_exit: true,
        };
        let poll = Arc::new(Poller::new()?);
        let mut native = tty::new(&options, size.window_size(), 0)?;
        let child_pid = native.child().id() as i32;
        // SAFETY: the worker retains both the PTY and poller and deregisters
        // before dropping the PTY. Failed startup also deregisters below.
        if let Err(error) = unsafe { native.register(&poll, Event::readable(0), PollMode::Level) } {
            let _ = native.deregister(&poll);
            signal(&native, libc::SIGKILL);
            return Err(error);
        }
        let state = Arc::new(Mutex::new(State::default()));
        let worker_state = state.clone();
        let worker_poll = poll.clone();
        // Keep ownership outside the closure until thread creation succeeds.
        let slot = Arc::new(Mutex::new(Some(native)));
        let worker_slot = slot.clone();
        thread::Builder::new()
            .name("termy-code-pty".into())
            .spawn(move || {
                let mut native = worker_slot.lock().unwrap().take().unwrap();
                run(&mut native, &worker_poll, &worker_state, on_output);
                let _ = native.deregister(&worker_poll);
                drop(native);
                on_exit();
            })
            .map_err(|error| {
                if let Some(mut native) = slot.lock().unwrap().take() {
                    let _ = native.deregister(&poll);
                    signal(&native, libc::SIGKILL);
                }
                error
            })?;
        Ok(Self {
            state,
            poll,
            child_pid,
        })
    }

    pub fn write_owned(&self, bytes: Vec<u8>) -> io::Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.exited || state.kill {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "Terminal is closed",
            ));
        }
        if bytes.len() > MAX_INPUT_BYTES.saturating_sub(state.input_bytes) {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "Terminal input queue is full",
            ));
        }
        if !bytes.is_empty() {
            state.input_bytes += bytes.len();
            state.input.push_back(bytes);
        }
        self.poll.notify()
    }

    pub fn resize(&self, size: PtySize) -> io::Result<()> {
        self.state.lock().unwrap().resize = Some(size);
        self.poll.notify()
    }

    pub fn exit_status(&self) -> Option<PtyExitStatus> {
        self.state.lock().unwrap().status
    }

    pub fn kill(&self) -> io::Result<()> {
        let mut state = self.state.lock().unwrap();
        if !state.exited && !state.kill {
            // Reaping uses the same lock, so this cannot signal a reused PID.
            signal_pid(self.child_pid, libc::SIGKILL);
            state.kill = true;
        }
        self.poll.notify()
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        // Daemon shutdown may exit before the worker wakes, so signal now.
        // The worker remains responsible for reaping and final output.
        let _ = self.kill();
    }
}

fn signal(pty: &tty::Pty, signal: i32) {
    signal_pid(pty.child().id() as i32, signal);
}

fn signal_pid(pid: i32, signal: i32) {
    // SAFETY: this worker owns the unreaped child. Alacritty creates a new
    // session/process group with this PID. Signal descendants as well as the shell.
    unsafe {
        libc::kill(-pid, signal);
        libc::kill(pid, signal);
    }
}

fn read_output(pty: &mut tty::Pty, on_output: &mut impl FnMut(&[u8])) -> io::Result<bool> {
    let mut buffer = [0; 32 * 1024];
    let mut total = 0;
    while total < IO_BUDGET {
        match pty.reader().read(&mut buffer) {
            Ok(0) => return Ok(false),
            Ok(n) => {
                on_output(&buffer[..n]);
                total += n;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) if error.raw_os_error() == Some(libc::EIO) => return Ok(false),
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

fn run(
    pty: &mut tty::Pty,
    poll: &Arc<Poller>,
    state: &Mutex<State>,
    mut on_output: impl FnMut(&[u8]),
) {
    let mut events = Events::new();
    let mut pending = Vec::new();
    let mut offset = 0;
    let mut readable = true;
    let mut killed = false;
    loop {
        let exited = {
            let mut state = state.lock().unwrap();
            if let Some(ChildEvent::Exited(status)) = pty.next_child_event() {
                state.status = status.map(|status| PtyExitStatus {
                    code: status.code(),
                    signal: status.signal(),
                });
                state.exited = true;
                state.input.clear();
                state.input_bytes = 0;
            }
            state.exited
        };
        if exited {
            // Final output precedes the callback, including quick commands.
            let _ = read_output(pty, &mut on_output);
            return;
        }
        let (resize, kill) = {
            let mut state = state.lock().unwrap();
            if offset == pending.len() {
                pending = state.input.pop_front().unwrap_or_default();
                offset = 0;
            }
            (state.resize.take(), state.kill)
        };
        if !killed && kill {
            signal(pty, libc::SIGKILL);
            killed = true;
        }
        if let Some(size) = resize {
            pty.on_resize(size.window_size());
        }
        if readable {
            match read_output(pty, &mut on_output) {
                Ok(open) => readable = open,
                Err(_) => {
                    readable = false;
                    state.lock().unwrap().kill = true;
                    continue;
                }
            }
        }
        if offset < pending.len() {
            let end = pending.len().min(offset + IO_BUDGET);
            match pty.writer().write(&pending[offset..end]) {
                Ok(0) => {
                    state.lock().unwrap().kill = true;
                    continue;
                }
                Ok(n) => {
                    offset += n;
                    state.lock().unwrap().input_bytes -= n;
                    if offset == pending.len() {
                        continue;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(_) => {
                    state.lock().unwrap().kill = true;
                    pending.clear();
                    offset = 0;
                    continue;
                }
            }
        }
        let mut interest = Event::none(0);
        interest.readable = readable;
        interest.writable = offset < pending.len();
        if pty.reregister(poll, interest, PollMode::Level).is_err() {
            signal(pty, libc::SIGKILL);
            break;
        }
        events.clear();
        if let Err(error) = poll.wait(&mut events, None) {
            if error.kind() != io::ErrorKind::Interrupted {
                signal(pty, libc::SIGKILL);
                break;
            }
        }
    }
    // Dropping Alacritty's PTY reaps the child even on an I/O failure.
    state.lock().unwrap().exited = true;
}

#[cfg(test)]
mod tests;
