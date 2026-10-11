//! Start at login with a crash supervisor, using the platform's own scheduler so no helper process stays resident.
//!
//! Windows registers a per-user scheduled task that runs at logon and restarts the tray after a failed exit. macOS writes a LaunchAgent whose `KeepAlive` restarts the tray after a crash. In both, a clean exit (Quit in the menu) is not restarted, so Quit lasts until the next login.

use std::path::Path;

const TASK_NAME: &str = "Scout Tray";
#[cfg(any(target_os = "macos", test))]
const AGENT_LABEL: &str = "dev.neostryder.scout-tray";

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The scheduled task: run at this user's logon, restart every minute up to 999 times after a failed exit, never time out, never start a second copy.
pub fn windows_task_xml(exe: &str, user: &str) -> String {
    let (exe, user) = (xml_escape(exe), xml_escape(user));
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts the Scout tray at login and restarts it after a crash.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Hidden>false</Hidden>
  </Settings>
  <Actions Context="Author"><Exec><Command>{exe}</Command></Exec></Actions>
</Task>
"#
    )
}

/// The LaunchAgent: run at login, restart after any exit that is not a clean one, and wait at least 10 seconds between starts.
#[cfg(any(target_os = "macos", test))]
pub fn mac_plist(exe: &str) -> String {
    let exe = xml_escape(exe);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>{exe}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
"#
    )
}

#[cfg(windows)]
fn utf16_with_bom(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

#[cfg(windows)]
fn schtasks(args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("schtasks.exe").args(args).creation_flags(CREATE_NO_WINDOW).output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(windows)]
pub fn enable(exe: &Path, config_dir: &Path) -> Result<(), String> {
    let user = format!("{}\\{}", std::env::var("USERDOMAIN").unwrap_or_default(), std::env::var("USERNAME").map_err(|e| e.to_string())?);
    std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    let file = config_dir.join("scout-tray-task.xml");
    std::fs::write(&file, utf16_with_bom(&windows_task_xml(&exe.to_string_lossy(), &user))).map_err(|e| e.to_string())?;
    let result = schtasks(&["/Create", "/TN", TASK_NAME, "/XML", &file.to_string_lossy(), "/F"]);
    let _ = std::fs::remove_file(&file);
    result
}

#[cfg(windows)]
pub fn disable() -> Result<(), String> {
    match schtasks(&["/Delete", "/TN", TASK_NAME, "/F"]) {
        Err(message) if !message.to_lowercase().contains("cannot find") => Err(message),
        _ => Ok(()),
    }
}

#[cfg(target_os = "macos")]
fn agent_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(Path::new(&home).join("Library/LaunchAgents").join(format!("{AGENT_LABEL}.plist")))
}

#[cfg(target_os = "macos")]
pub fn enable(exe: &Path, _config_dir: &Path) -> Result<(), String> {
    let path = agent_path()?;
    let text = mac_plist(&exe.to_string_lossy());
    if std::fs::read_to_string(&path).map(|current| current == text).unwrap_or(false) {
        return Ok(());
    }
    std::fs::create_dir_all(path.parent().ok_or("no folder")?).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
pub fn disable() -> Result<(), String> {
    match std::fs::remove_file(agent_path()?) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn enable(_exe: &Path, _config_dir: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn disable() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{mac_plist, windows_task_xml};

    /// Registers the generated task under a probe name, reads it back, and removes it. It changes the machine's scheduler, so it runs only on request: `cargo test -- --ignored`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn the_scheduler_accepts_the_generated_task() {
        let user = format!("{}\\{}", std::env::var("USERDOMAIN").unwrap(), std::env::var("USERNAME").unwrap());
        let file = std::env::temp_dir().join("scout-tray-task-probe.xml");
        std::fs::write(&file, super::utf16_with_bom(&windows_task_xml(r"C:\Windows\System32\notepad.exe", &user))).unwrap();
        super::schtasks(&["/Create", "/TN", "Scout Tray Probe", "/XML", &file.to_string_lossy(), "/F"]).unwrap();
        let queried = super::schtasks(&["/Query", "/TN", "Scout Tray Probe"]);
        super::schtasks(&["/Delete", "/TN", "Scout Tray Probe", "/F"]).unwrap();
        let _ = std::fs::remove_file(&file);
        queried.unwrap();
    }

    #[test]
    fn the_windows_task_runs_at_logon_and_restarts_after_a_failure() {
        let xml = windows_task_xml(r"C:\Apps\Scout & Co\scout-tray.exe", r"HOME\neo");
        assert!(xml.contains("<LogonTrigger>"));
        assert!(xml.contains("<UserId>HOME\\neo</UserId>"));
        assert!(xml.contains("<Command>C:\\Apps\\Scout &amp; Co\\scout-tray.exe</Command>"));
        assert!(xml.contains("<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>"));
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
    }

    #[test]
    fn the_mac_agent_restarts_only_after_an_unclean_exit() {
        let plist = mac_plist("/Applications/Scout Tray.app/Contents/MacOS/scout-tray");
        assert!(plist.contains("<key>RunAtLoad</key><true/>"));
        assert!(plist.contains("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"));
        assert!(plist.contains("<string>/Applications/Scout Tray.app/Contents/MacOS/scout-tray</string>"));
        assert!(plist.contains("dev.neostryder.scout-tray"));
    }
}
