use super::{Pty, PtyCommand, PtySize, TerminalLaunch};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

#[test]
fn raw_output_environment_and_exit_status_are_ready_when_exit_fires() {
    let launch = TerminalLaunch::Program {
        program: "/bin/sh".into(),
        args: vec![
            "-c".into(),
            "printf '\\033[32m%s\\033[0m' \"$TERMY_PTY_TEST\"; exit 7".into(),
        ],
    };
    let environment = [("TERMY_PTY_TEST".into(), "raw-output".into())];
    let output = Arc::new(Mutex::new(Vec::new()));
    let sink = output.clone();
    let (tx, rx) = mpsc::channel();
    let pty = Pty::spawn(
        PtyCommand {
            launch: Some(&launch),
            environment: &environment,
            ..Default::default()
        },
        PtySize::new(80, 24),
        move |bytes| sink.lock().unwrap().extend_from_slice(bytes),
        move || {
            let _ = tx.send(());
        },
    )
    .unwrap();
    rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(*output.lock().unwrap(), b"\x1b[32mraw-output\x1b[0m");
    let status = pty.exit_status().unwrap();
    assert_eq!(status.code, Some(7));
    assert_eq!(status.signal, None);
    pty.kill().expect("killing an exited child is a no-op");
}

#[test]
fn resize_and_input_reach_the_child() {
    let launch = TerminalLaunch::Program {
        program: "/bin/sh".into(),
        args: vec![
            "-c".into(),
            "stty -echo; printf '<ready>'; read line; stty size; printf '<%s>' \"$line\"".into(),
        ],
    };
    let (tx, rx) = mpsc::channel();
    let (exit_tx, exit_rx) = mpsc::channel();
    let pty = Pty::spawn(
        PtyCommand {
            launch: Some(&launch),
            ..Default::default()
        },
        PtySize::new(80, 24),
        move |bytes| {
            let _ = tx.send(bytes.to_vec());
        },
        move || {
            let _ = exit_tx.send(());
        },
    )
    .unwrap();
    let mut output = Vec::new();
    while !String::from_utf8_lossy(&output).contains("<ready>") {
        output.extend(rx.recv_timeout(Duration::from_secs(5)).unwrap());
    }
    pty.resize(PtySize::new(100, 40)).unwrap();
    pty.write_owned(b"hello\n".to_vec()).unwrap();
    exit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    for bytes in rx.try_iter() {
        output.extend(bytes);
    }
    let text = String::from_utf8_lossy(&output);
    assert!(text.contains("40 100"), "{text}");
    assert!(text.contains("<hello>"), "{text}");
}

#[test]
fn kill_reports_a_signal_and_keeps_output_available() {
    let launch = TerminalLaunch::Program {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), "printf '<ready>'; exec sleep 30".into()],
    };
    let (tx, rx) = mpsc::channel();
    let (exit_tx, exit_rx) = mpsc::channel();
    let pty = Pty::spawn(
        PtyCommand {
            launch: Some(&launch),
            ..Default::default()
        },
        PtySize::new(80, 24),
        move |bytes| {
            let _ = tx.send(bytes.to_vec());
        },
        move || {
            let _ = exit_tx.send(());
        },
    )
    .unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), b"<ready>");
    pty.kill().unwrap();
    exit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let status = pty.exit_status().unwrap();
    assert_eq!(status.signal, Some(9));
    assert_eq!(status.code, None);
}

#[test]
fn backpressure_does_not_block_drop_or_leave_an_ignoring_child_alive() {
    let launch = TerminalLaunch::Program {
        program: "/bin/sh".into(),
        args: vec![
            "-c".into(),
            "trap '' HUP; stty -echo; printf '<ready>'; exec sleep 30".into(),
        ],
    };
    let (tx, rx) = mpsc::channel();
    let (exit_tx, exit_rx) = mpsc::channel();
    let pty = Pty::spawn(
        PtyCommand {
            launch: Some(&launch),
            ..Default::default()
        },
        PtySize::new(80, 24),
        move |bytes| {
            let _ = tx.send(bytes.to_vec());
        },
        move || {
            let _ = exit_tx.send(());
        },
    )
    .unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), b"<ready>");
    let error = pty
        .write_owned(vec![b'x'; super::MAX_INPUT_BYTES + 1])
        .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
    pty.write_owned(vec![b'x'; super::MAX_INPUT_BYTES]).unwrap();
    drop(pty);
    exit_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("drop must reap even a child ignoring SIGHUP");
}

#[test]
fn invalid_working_directory_fails_instead_of_running_elsewhere() {
    let result = Pty::spawn(
        PtyCommand {
            working_directory: Some("/dev/null/not-a-directory"),
            ..Default::default()
        },
        PtySize::new(80, 24),
        |_| {},
        || {},
    );
    assert!(matches!(result, Err(error) if error.kind() == std::io::ErrorKind::NotFound));
}
