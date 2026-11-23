use serde::Deserialize;
use std::{env, fs, path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForkSelfUpdatePolicy {
    enabled: bool,
    disabled_message: String,
}

fn main() {
    let policy_path = "../../packages/shared-contracts/src/fork-self-update.json";
    println!("cargo:rerun-if-changed={policy_path}");
    let policy: ForkSelfUpdatePolicy =
        serde_json::from_slice(&fs::read(policy_path).expect("read fork self-update policy"))
            .expect("parse fork self-update policy");
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    fs::write(
        output.join("fork_self_update.rs"),
        format!(
            "pub const FORK_SELF_UPDATE_ENABLED: bool = {};\n\
             pub const FORK_SELF_UPDATE_DISABLED_MESSAGE: &str = {:?};\n",
            policy.enabled, policy.disabled_message
        ),
    )
    .expect("write fork self-update policy");
}
