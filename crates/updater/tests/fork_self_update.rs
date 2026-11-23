use std::io::Write;
use std::process::{Command, Output, Stdio};

use codexhost_platform::{FORK_SELF_UPDATE_DISABLED_MESSAGE, FORK_SELF_UPDATE_ENABLED};

fn assert_refused(output: Output) {
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains(FORK_SELF_UPDATE_DISABLED_MESSAGE));
}

#[test]
fn refuses_local_and_remote_update_requests_before_opening_the_request_file() {
    if FORK_SELF_UPDATE_ENABLED {
        return;
    }
    for action in ["apply", "remote"] {
        let output = Command::new(env!("CARGO_BIN_EXE_codexhost-updater"))
            .args([action, "--request", "not-a-request-file"])
            .output()
            .unwrap();
        assert_refused(output);
    }
}

#[test]
fn refuses_ssh_package_installation_before_running_ssh() {
    if FORK_SELF_UPDATE_ENABLED {
        return;
    }
    for action in ["install", "update"] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_codexhost-updater"))
            .arg("ssh")
            .env("PATH", "")
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        write!(
            child.stdin.take().unwrap(),
            r#"{{"hostname":"fixture.invalid","action":"{action}","version":"0.25.2"}}"#
        )
        .unwrap();
        assert_refused(child.wait_with_output().unwrap());
    }
}
