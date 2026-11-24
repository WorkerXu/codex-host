use super::spawn_supervised;
use crate::process_snapshot;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::{env, io, thread};

const FOREIGN_TEST: &str =
    "process_supervision::linux_tests::excludes_a_foreign_group_member_without_signaling_it";
const FOREIGN_ROLE: &str = "CODEXHOST_FOREIGN_MEMBER_TEST_ROLE";
const FOREIGN_GROUP: &str = "CODEXHOST_FOREIGN_MEMBER_TEST_GROUP";

fn wait_until(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting until {what}");
        thread::sleep(Duration::from_millis(20));
    }
}

fn first_numeric_line(reader: &mut impl BufRead) -> Vec<u32> {
    let mut line = String::new();
    loop {
        line.clear();
        assert!(reader.read_line(&mut line).expect("read fixture output") > 0);
        let values = line
            .split_ascii_whitespace()
            .map(str::parse::<u32>)
            .collect::<Result<Vec<_>, _>>();
        if let Ok(values) = values
            && !values.is_empty()
        {
            return values;
        }
    }
}

#[test]
fn excludes_an_orphan_left_by_a_short_lived_descendant() {
    assert_unobserved_orphan_survives_stop(&[]);
}

#[test]
fn leaves_an_unobserved_orphan_in_a_new_session_to_the_system() {
    assert_unobserved_orphan_survives_stop(&["/usr/bin/setsid"]);
}

fn assert_unobserved_orphan_survives_stop(wrapper: &[&str]) {
    // The root and orphan both block on the same pipe. Closing it lets the
    // fixture exit even if an assertion fails.
    let mut command = Command::new("/bin/sh");
    command
        .args([
            "-c",
            r#"
                exec 3<&0
                /bin/sh -c '
                    echo "$$"
                    script=$1
                    shift
                    "$@" /bin/sh -c "$script" <&3 &
                ' fixture 'echo "$$"; read -r token' "$@"
                read -r token
            "#,
            "fixture",
        ])
        .args(wrapper)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut root = spawn_supervised(&mut command).expect("supervise fixture root");
    let stdin = root.take_stdin().expect("fixture stdin");
    let mut stdout = BufReader::new(root.take_stdout().expect("fixture stdout"));
    let [intermediate] = first_numeric_line(&mut stdout)[..] else {
        panic!("fixture did not report its intermediate PID");
    };
    let [orphan] = first_numeric_line(&mut stdout)[..] else {
        panic!("fixture did not report its orphan PID");
    };
    wait_until("the orphan is reparented", Duration::from_secs(2), || {
        process_snapshot(orphan).is_ok_and(|process| process.parent_id != intermediate)
    });
    let original = process_snapshot(orphan).expect("orphan is still running");
    let expected_group = if wrapper.is_empty() {
        root.process_group_id()
    } else {
        orphan
    };
    assert_eq!(original.process_group_id, expected_group);

    assert!(root.has_live_processes().expect("observe fixture tree"));
    root.terminate().expect("signal owned processes");
    let status = root
        .wait_for_tree_exit(Duration::from_secs(2))
        .expect("the supervised tree exits while the orphan is still alive");
    assert_eq!(status.signal(), Some(nix::libc::SIGTERM));
    drop(root);

    let live = process_snapshot(orphan).expect("orphan survives supervisor shutdown");
    assert_eq!(live.started_at_micros, original.started_at_micros);
    assert_ne!(
        live.parent_id,
        std::process::id(),
        "supervisor adopted the orphan"
    );

    drop(stdin);
    wait_until(
        "the orphan exits on fixture EOF",
        Duration::from_secs(2),
        || {
            !process_snapshot(orphan)
                .is_ok_and(|process| process.started_at_micros == original.started_at_micros)
        },
    );
}

#[test]
fn excludes_a_foreign_group_member_without_signaling_it() {
    match env::var(FOREIGN_ROLE).as_deref() {
        Ok("member") => {
            // Joins the supervised group without descending from its root
            // or from the supervisor, then waits for the supervisor's EOF.
            let group = env::var(FOREIGN_GROUP)
                .expect("foreign group")
                .parse::<i32>()
                .expect("numeric foreign group");
            let mut foreign = Command::new("/bin/sleep")
                .arg("30")
                .process_group(group)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .spawn()
                .expect("join the supervised process group");
            println!("{}", foreign.id());
            io::stdout().flush().expect("report foreign PID");
            let _ = io::stdin().read(&mut [0_u8; 1]);
            let _ = foreign.kill();
            let _ = foreign.wait();
            return;
        }
        Ok("supervisor") => {
            run_foreign_member_supervisor();
            return;
        }
        _ => {}
    }
    // The supervisor runs in its own test process so its stderr diagnostics
    // can be asserted.
    let output = Command::new(env::current_exe().expect("test executable"))
        .args(["--exact", FOREIGN_TEST, "--nocapture"])
        .env(FOREIGN_ROLE, "supervisor")
        .stdin(Stdio::null())
        .output()
        .expect("run supervisor fixture");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stdout}\n{stderr}");
    let foreign = stdout
        .lines()
        .find_map(|line| line.strip_prefix("foreign="))
        .expect("supervisor reported the foreign PID");
    assert_eq!(
        stderr
            .matches(&format!("excluded unattributed PID {foreign} "))
            .count(),
        1,
        "{stderr}"
    );
}

fn run_foreign_member_supervisor() {
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "echo ready; read -r token"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut root = spawn_supervised(&mut command).expect("supervise fixture root");
    let mut ready = String::new();
    BufReader::new(root.take_stdout().expect("root stdout"))
        .read_line(&mut ready)
        .expect("read root readiness");
    assert_eq!(ready, "ready\n");
    let group = root.process_group_id();
    let mut member = Command::new(env::current_exe().expect("test executable"))
        .args(["--exact", FOREIGN_TEST, "--nocapture"])
        .env(FOREIGN_ROLE, "member")
        .env(FOREIGN_GROUP, group.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn foreign member parent");
    // Keep the pipe open until the member exits so its test harness can
    // still report.
    let mut member_stdout = BufReader::new(member.stdout.take().expect("member stdout"));
    let [foreign] = first_numeric_line(&mut member_stdout)[..] else {
        panic!("member did not report the foreign PID");
    };
    let foreign_snapshot = process_snapshot(foreign).expect("foreign member is running");
    assert_eq!(foreign_snapshot.process_group_id, group);
    assert_eq!(foreign_snapshot.parent_id, member.id());

    for _ in 0..3 {
        assert!(
            root.has_live_processes()
                .expect("a foreign group member must not abort supervision")
        );
    }
    root.force_terminate().expect("terminate owned processes");
    root.wait().expect("root exits");
    root.wait_for_tree_exit(Duration::from_secs(5))
        .expect("supervised tree exits without waiting for the foreign member");
    let survived = process_snapshot(foreign)
        .is_ok_and(|live| live.started_at_micros == foreign_snapshot.started_at_micros);

    drop(member.stdin.take());
    member.wait().expect("foreign member parent exits");
    drop(member_stdout);
    assert!(survived, "cleanup signaled the foreign group member");
    println!("foreign={foreign}");
}

#[test]
fn leaves_a_separately_owned_child_and_its_exit_status_to_its_owner() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "read -r keep"]).stdin(Stdio::piped());
    let mut root = spawn_supervised(&mut command).expect("supervise fixture root");
    let mut separate = Command::new("/bin/sh")
        .args(["-c", "read -r keep; exit 42"])
        .process_group(root.process_group_id() as i32)
        .stdin(Stdio::piped())
        .spawn()
        .expect("spawn separate child in same group");
    let original = process_snapshot(separate.id()).expect("separate child is running");

    assert!(root.has_live_processes().expect("observe fixture tree"));
    root.force_terminate().expect("force cleanup of owned tree");
    root.wait_for_tree_exit(Duration::from_secs(2))
        .expect("supervised tree exits while the separate child is still alive");
    assert!(
        process_snapshot(separate.id())
            .is_ok_and(|process| { process.started_at_micros == original.started_at_micros })
    );

    drop(separate.stdin.take());
    wait_until("the separate child exits", Duration::from_secs(2), || {
        process_snapshot(separate.id()).is_err()
    });
    assert!(!root.has_live_processes().expect("observe fixture tree"));
    assert_eq!(
        separate
            .wait()
            .expect("separate Child must retain its exit status")
            .code(),
        Some(42)
    );
}
