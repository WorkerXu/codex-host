//! Keeps the stderr of detached service supervisors. They run without a
//! terminal, so their fatal errors and process-supervision diagnostics would
//! otherwise be lost.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const ROTATE_BYTES: u64 = 1024 * 1024;

/// Appends `command`'s stderr to `<data>/logs/<name>` across supervisor runs,
/// after moving a file larger than 1 MiB to `<name>.1`. If the log cannot be
/// opened, stderr stays as configured: diagnostics never block a start.
pub(super) fn capture_stderr(command: &mut Command, data: &Path, name: &str) {
    if let Ok(file) = open(&data.join("logs"), name) {
        command.stderr(file);
    }
}

fn open(directory: &Path, name: &str) -> io::Result<File> {
    fs::create_dir_all(directory)?;
    let path = directory.join(name);
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        options.mode(0o600);
    }
    if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > ROTATE_BYTES) {
        // A file still open by another process may refuse the move; keep appending then.
        let _ = fs::rename(&path, directory.join(format!("{name}.1")));
    }
    let file = options.open(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

/// Writes one supervisor lifecycle line, stamped with UTC time and PID.
pub(super) fn record(event: &str) {
    let _ = writeln!(
        io::stderr(),
        "{} [{}] {event}",
        utc_timestamp(SystemTime::now()),
        std::process::id()
    );
}

fn utc_timestamp(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let clock = seconds % 86_400;
    // Civil date from days since 1970-01-01 (proleptic Gregorian calendar).
    let shifted = (seconds / 86_400) as i64 + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        clock / 3_600,
        clock % 3_600 / 60,
        clock % 60
    )
}

#[cfg(test)]
mod tests {
    use super::{capture_stderr, utc_timestamp};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn formats_utc_timestamps() {
        for (seconds, expected) in [
            (0, "1970-01-01T00:00:00Z"),
            (951_782_400, "2000-02-29T00:00:00Z"),
            (1_795_489_193, "2026-11-24T02:59:53Z"),
        ] {
            assert_eq!(
                utc_timestamp(UNIX_EPOCH + Duration::from_secs(seconds)),
                expected
            );
        }
        assert!(utc_timestamp(SystemTime::now()).ends_with('Z'));
    }

    #[cfg(unix)]
    #[test]
    fn appends_supervisor_stderr_to_a_private_rotating_log() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::{Command, Stdio};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is before the Unix epoch")
            .as_nanos();
        let data = std::env::temp_dir().join(format!(
            "codexhost-service-log-{}-{unique}",
            std::process::id()
        ));
        let logs = data.join("logs");
        std::fs::create_dir_all(&logs).expect("create log directory");
        let log = logs.join("host-service.log");
        std::fs::write(&log, vec![b'x'; 1024 * 1024 + 1]).expect("write oversized log");
        let run = |message: &str| {
            let mut command = Command::new("/bin/sh");
            command
                .args(["-c", &format!("echo {message} >&2")])
                .stderr(Stdio::null());
            capture_stderr(&mut command, &data, "host-service.log");
            assert!(command.status().expect("run fixture").success());
        };
        run("first");
        run("second");

        assert_eq!(
            std::fs::read_to_string(&log).expect("read log"),
            "first\nsecond\n"
        );
        assert_eq!(
            std::fs::metadata(logs.join("host-service.log.1"))
                .expect("rotated log")
                .len(),
            1024 * 1024 + 1
        );
        for (path, mode) in [(&logs, 0o700), (&log, 0o600)] {
            let actual = std::fs::metadata(path).expect("stat").permissions().mode() & 0o777;
            assert_eq!(actual, mode, "{}", path.display());
        }
        std::fs::remove_dir_all(data).expect("remove temporary directory");
    }
}
