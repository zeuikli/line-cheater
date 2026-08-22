use std::fs;
use std::path::Path;

use line_cheater_app_lib::local_cleanup::{
    LocalCleanupManager, Platform, ProcessInfo, discover_line_profile_from,
    is_recognized_line_process,
};

fn write(root: &Path, relative: &str, contents: &[u8]) {
    let target = root.join(relative);
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(target, contents).unwrap();
}

#[test]
fn recognizes_only_verified_line_processes() {
    assert!(is_recognized_line_process(
        Platform::Macos,
        &ProcessInfo::new("LINE", "/Applications/LINE.app/Contents/MacOS/LINE", 10)
    ));
    assert!(!is_recognized_line_process(
        Platform::Macos,
        &ProcessInfo::new("deadline", "/tmp/deadline", 11)
    ));
    assert!(is_recognized_line_process(
        Platform::Windows,
        &ProcessInfo::new(
            "LINE.exe",
            r"C:\Users\me\AppData\Local\LINE\bin\LINE.exe",
            12
        )
    ));
}

#[test]
fn discovers_only_fixed_profile_locations() {
    let temp = tempfile::tempdir().unwrap();
    let expected = temp
        .path()
        .join("Library/Containers/jp.naver.line.mac/Data/Library/Containers/jp.naver.line/Data");
    fs::create_dir_all(&expected).unwrap();
    assert_eq!(
        discover_line_profile_from(Platform::Macos, temp.path(), None, None).unwrap(),
        expected.canonicalize().unwrap()
    );
}

#[test]
fn scan_allowlists_cache_files_and_delete_revalidates_them() {
    let temp = tempfile::tempdir().unwrap();
    write(temp.path(), "Sticker/pack/selected.png", b"selected");
    write(temp.path(), "Sticon/pack/icon.bin", b"icon");
    write(temp.path(), "db/account.edb", b"must stay");

    let mut manager = LocalCleanupManager::for_profile(Platform::Macos, temp.path()).unwrap();
    let inventory = manager.scan_with(|| false).unwrap();
    assert_eq!(inventory.items.len(), 2);
    assert!(inventory.items.iter().all(|item| item.id.len() == 64));
    assert!(
        !inventory
            .items
            .iter()
            .any(|item| item.relative_path.contains("db/"))
    );

    let selected = inventory
        .items
        .iter()
        .find(|item| item.name == "selected.png")
        .unwrap();
    let mut trashed = Vec::new();
    let result = manager
        .delete_with(
            &inventory.token,
            std::slice::from_ref(&selected.id),
            || false,
            |path| {
                trashed.push(path.to_path_buf());
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(result.local.deleted, 1);
    assert_eq!(trashed.len(), 1);
    assert_eq!(result.cloud.status, "unsupported");
}

#[test]
fn scan_refuses_while_line_is_running_and_changed_files_are_never_deleted() {
    let temp = tempfile::tempdir().unwrap();
    write(temp.path(), "Sticker/item.png", b"before");
    let mut manager = LocalCleanupManager::for_profile(Platform::Macos, temp.path()).unwrap();
    assert!(manager.scan_with(|| true).is_err());

    let inventory = manager.scan_with(|| false).unwrap();
    fs::write(temp.path().join("Sticker/item.png"), b"after-after").unwrap();
    let result = manager.delete_with(
        &inventory.token,
        &[inventory.items[0].id.clone()],
        || false,
        |_| panic!("changed file must not be trashed"),
    );
    assert!(result.is_err());
}
