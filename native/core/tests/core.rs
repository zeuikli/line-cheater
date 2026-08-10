use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::anyhow;
use line_backup_native::{
    AttachmentKind, CandidateOptions, Catalog, Chat, ChatCursor, ExportOptions, ExportScope,
    LineDatabase, LineSquareDatabase, MessageCursor, NativeSession, PreparePhase, SourceKind,
    UnifiedGroupDatabase, build_candidate, build_candidate_with_options, inspect_source,
    line_square_rebuild_required, prepare_source, prepare_source_reporting, serve,
};
use rusqlite::{Connection, params};
use tempfile::TempDir;
use zip::write::SimpleFileOptions;

fn make_fixture(root: &Path) -> PathBuf {
    let source = root.join("LINE");
    let messages = source.join(
        "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test/Messages",
    );
    let attachments = source.join(
        "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test/Message Attachments/u1",
    );
    let thumbnails = source.join(
        "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test/Message Thumbnails/u1",
    );
    fs::create_dir_all(&messages).unwrap();
    fs::create_dir_all(&attachments).unwrap();
    fs::create_dir_all(&thumbnails).unwrap();
    fs::write(attachments.join("12345678.jpg"), b"\xff\xd8\xffimage123").unwrap();
    fs::write(thumbnails.join("12345678.thumb"), b"\x89PNG\r\n\x1a\n").unwrap();

    let database = messages.join("Line.sqlite");
    let connection = Connection::open(&database).unwrap();
    connection
        .execute_batch(
            "
            CREATE TABLE ZCHAT (
                Z_PK INTEGER PRIMARY KEY,
                ZMID TEXT,
                ZTYPE INTEGER,
                ZLASTUPDATED INTEGER,
                ZLASTMESSAGE TEXT
            );
            CREATE TABLE ZUSER (
                Z_PK INTEGER PRIMARY KEY,
                ZMID TEXT,
                ZNAME TEXT
            );
            CREATE TABLE ZGROUP (
                Z_PK INTEGER PRIMARY KEY,
                ZID TEXT,
                ZNAME TEXT
            );
            CREATE TABLE ZMESSAGE (
                Z_PK INTEGER PRIMARY KEY,
                ZID TEXT,
                ZTIMESTAMP INTEGER,
                ZCHAT INTEGER,
                ZSENDER INTEGER,
                ZSENDSTATUS INTEGER,
                ZCONTENTTYPE INTEGER,
                ZMESSAGETYPE TEXT,
                ZTEXT TEXT,
                ZLATITUDE REAL,
                ZLONGITUDE REAL
            );
            INSERT INTO ZUSER VALUES (1, 'u1', 'Alice');
            INSERT INTO ZUSER VALUES (2, 'test', 'Backup Owner');
            INSERT INTO ZCHAT VALUES (7, 'u1', 0, 200, 'second');
            INSERT INTO ZMESSAGE VALUES (1, 'm1', 100, 7, 1, 1, 0, 'R', 'first', NULL, NULL);
            INSERT INTO ZMESSAGE VALUES (2, 'm2', 100, 7, 2, 1, 0, 'R', 'same time', NULL, NULL);
            INSERT INTO ZMESSAGE VALUES (3, 'm3', 200, 7, 1, 0, 0, 'R', 'second', NULL, NULL);
            INSERT INTO ZMESSAGE VALUES (4, '12345678', 300, 7, 1, 0, 1, 'R', 'photo context', NULL, NULL);
            CREATE INDEX message_chat_time ON ZMESSAGE(ZCHAT, ZTIMESTAMP, Z_PK);
            ",
        )
        .unwrap();
    connection.close().unwrap();
    source
}

fn add_many_attachment_contexts(source: &Path, count: u32) {
    let line_database = source.join(inspect_source(source).unwrap().database_path);
    let attachments = line_database
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("Message Attachments/u1");
    fs::create_dir_all(&attachments).unwrap();
    let mut connection = Connection::open(&line_database).unwrap();
    let transaction = connection.transaction().unwrap();
    {
        let mut insert = transaction
            .prepare(
                "INSERT INTO ZMESSAGE (
                    Z_PK, ZID, ZTIMESTAMP, ZCHAT, ZSENDER, ZSENDSTATUS,
                    ZCONTENTTYPE, ZMESSAGETYPE, ZTEXT, ZLATITUDE, ZLONGITUDE
                ) VALUES (?1, ?2, ?3, 7, 1, 0, 1, 'R', 'bulk attachment', NULL, NULL)",
            )
            .unwrap();
        for offset in 0..count {
            let id = 10_000_000_i64 + i64::from(offset);
            insert
                .execute(params![id, id.to_string(), 1_000_i64 + i64::from(offset)])
                .unwrap();
            fs::write(attachments.join(format!("{id}.jpg")), b"bulk attachment").unwrap();
        }
    }
    transaction.commit().unwrap();
    connection.close().unwrap();
}

fn add_square_fixture(source: &Path) {
    let line_database = source.join(inspect_source(source).unwrap().database_path);
    let square_database = line_database.with_file_name("LineSquare.sqlite");
    let connection = Connection::open(&square_database).unwrap();
    connection
        .execute_batch(
            "
            CREATE TABLE ZCHAT (
                Z_PK INTEGER PRIMARY KEY,
                ZMID TEXT,
                ZTYPE INTEGER,
                ZSQUARE INTEGER,
                ZNAME TEXT
            );
            CREATE TABLE ZSQUARE (
                Z_PK INTEGER PRIMARY KEY,
                ZNAME TEXT
            );
            CREATE TABLE ZSQUAREMEMBER (
                Z_PK INTEGER PRIMARY KEY,
                ZDISPLAYNAME TEXT,
                ZMID TEXT
            );
            CREATE TABLE ZMESSAGE (
                Z_PK INTEGER PRIMARY KEY,
                ZID TEXT,
                ZTIMESTAMP INTEGER,
                ZCHAT INTEGER,
                ZSENDER INTEGER,
                ZSENDSTATUS INTEGER,
                ZCONTENTTYPE INTEGER,
                ZMESSAGETYPE TEXT,
                ZTEXT TEXT,
                ZLATITUDE REAL,
                ZLONGITUDE REAL
            );
            INSERT INTO ZSQUARE VALUES (3, 'Square A');
            INSERT INTO ZCHAT VALUES (8, 'square-chat', 0, 3, '');
            INSERT INTO ZSQUAREMEMBER VALUES (11, 'Square Sender', 'square-user');
            INSERT INTO ZSQUAREMEMBER VALUES (12, 'Backup Owner', 'test');
            INSERT INTO ZMESSAGE VALUES
                (12, '23456789', 400, 8, 11, 1, 1, 'R', 'square photo', NULL, NULL);
            INSERT INTO ZMESSAGE VALUES
                (13, 'square-self', 410, 8, 12, 1, 0, 'S', 'square self', NULL, NULL);
            ",
        )
        .unwrap();
    connection.close().unwrap();

    let attachment = line_database
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("Message Attachments/square-chat/23456789.jpg");
    fs::create_dir_all(attachment.parent().unwrap()).unwrap();
    fs::write(attachment, b"square attachment").unwrap();
}

fn corrupt_square_index(source: &Path) {
    let line_database = source.join(inspect_source(source).unwrap().database_path);
    let square_database = line_database.with_file_name("LineSquare.sqlite");
    let connection = Connection::open(&square_database).unwrap();
    connection
        .execute_batch(
            "
            CREATE TABLE ZCORRUPTION_SENTINEL (
                Z_PK INTEGER PRIMARY KEY,
                ZVALUE TEXT
            );
            INSERT INTO ZCORRUPTION_SENTINEL VALUES (1, 'sentinel');
            CREATE INDEX ZCORRUPTION_INDEX ON ZCORRUPTION_SENTINEL(ZVALUE);
            PRAGMA writable_schema = ON;
            ",
        )
        .unwrap();
    let table_root: i64 = connection
        .query_row(
            "SELECT rootpage FROM sqlite_schema WHERE name = 'ZCORRUPTION_SENTINEL'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    connection
        .execute(
            "UPDATE sqlite_schema SET rootpage = ?1 WHERE name = 'ZCORRUPTION_INDEX'",
            [table_root],
        )
        .unwrap();
    let schema_version: i64 = connection
        .query_row("PRAGMA schema_version", [], |row| row.get(0))
        .unwrap();
    connection
        .pragma_update(None, "schema_version", schema_version + 1)
        .unwrap();
    connection.close().unwrap();
}

fn add_chat_title_fixtures(source: &Path) {
    let line_database = source.join(inspect_source(source).unwrap().database_path);
    let connection = Connection::open(&line_database).unwrap();
    connection
        .execute_batch(
            "
            INSERT INTO ZCHAT VALUES (8, 'g-unified', 1, 400, 'group photo');
            INSERT INTO ZCHAT VALUES (9, 'g-renamed', 1, 500, 'renamed');
            INSERT INTO ZMESSAGE VALUES
                (20, '34567890', 400, 8, 1, 0, 1, 'R', 'group photo', NULL, NULL);
            INSERT INTO ZMESSAGE VALUES
                (21, 'rename-event', 500, 9, NULL, 0, 18, 'R',
                 '群組名稱改為「Renamed Room」', NULL, NULL);
            INSERT INTO ZMESSAGE VALUES
                (22, 'ordinary-message', 510, 9, 1, 0, 0, 'R',
                 'hello group', NULL, NULL);
            ",
        )
        .unwrap();
    connection.close().unwrap();

    let unified_database = line_database.with_file_name("UnifiedGroup.sqlite");
    let connection = Connection::open(&unified_database).unwrap();
    connection
        .execute_batch(
            "
            CREATE TABLE ZUNIFIEDGROUP (
                Z_PK INTEGER PRIMARY KEY,
                ZID TEXT,
                ZNAME TEXT,
                ZTYPE INTEGER
            );
            INSERT INTO ZUNIFIEDGROUP VALUES (1, 'g-unified', 'Unified Room', 1);
            ",
        )
        .unwrap();
    connection.close().unwrap();

    let attachment = line_database
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("Message Attachments/g-unified/34567890.jpg");
    fs::create_dir_all(attachment.parent().unwrap()).unwrap();
    fs::write(attachment, b"\xff\xd8\xffgroup-image").unwrap();
}

#[test]
fn inspects_private_store_database_and_opens_read_only() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let report = inspect_source(&source).unwrap();
    assert_eq!(report.kind, SourceKind::Directory);
    assert!(report.database_path.contains("PrivateStore/P_test"));
    let prepared = prepare_source(&source, &temporary.path().join("work")).unwrap();
    assert_eq!(prepared.account_id.as_deref(), Some("test"));
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    assert!(database.is_read_only().unwrap());
    assert_eq!(database.quick_check().unwrap(), "ok");
}

#[test]
fn detects_when_a_catalog_source_directory_has_changed() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let catalog_path = temporary.path().join("work/catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    assert!(
        catalog
            .source_matches_current(&source, SourceKind::Directory)
            .unwrap()
    );
    let attachment = catalog
        .list_attachments(None, 10, Some(AttachmentKind::Original), None)
        .unwrap()
        .items
        .into_iter()
        .next()
        .unwrap();
    catalog.set_marked(&attachment.path, true).unwrap();

    fs::write(source.join("new-top-level-file"), b"changed source").unwrap();
    assert!(
        !catalog
            .source_matches_current(&source, SourceKind::Directory)
            .unwrap()
    );
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    assert!(catalog.marked_paths().unwrap().is_empty());
}

#[test]
fn detects_when_a_nested_catalog_source_file_has_changed() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let catalog_path = temporary.path().join("work/catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    let nested = source.join(
        "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test/Message Attachments/u1/12345678.jpg",
    );
    fs::write(&nested, b"changed nested attachment").unwrap();
    assert!(
        !catalog
            .source_matches_current(&source, SourceKind::Directory)
            .unwrap()
    );
}

#[test]
fn detects_same_size_same_mtime_content_replacement() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let catalog_path = temporary.path().join("work/catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    let nested = source.join(
        "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test/Message Attachments/u1/12345678.jpg",
    );
    let original_mtime = fs::metadata(&nested).unwrap().modified().unwrap();
    let original = fs::read(&nested).unwrap();
    let replacement = vec![b'X'; original.len()];
    assert_ne!(original, replacement);
    fs::write(&nested, replacement).unwrap();
    fs::File::options()
        .write(true)
        .open(&nested)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(original_mtime))
        .unwrap();

    assert!(
        !catalog
            .source_matches_current(&source, SourceKind::Directory)
            .unwrap()
    );
}

#[test]
fn recovers_catalog_state_after_an_interrupted_operation() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let catalog_path = temporary.path().join("work/catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    let attachment = catalog
        .list_attachments(None, 10, Some(AttachmentKind::Original), None)
        .unwrap()
        .items
        .into_iter()
        .next()
        .unwrap();
    catalog.set_marked(&attachment.path, true).unwrap();
    drop(catalog);

    let connection = Connection::open(&catalog_path).unwrap();
    connection
        .execute(
            "INSERT INTO meta(key, value) VALUES ('scan_status', 'scanning')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO meta(key, value) VALUES ('hash_status', 'running')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .unwrap();
    connection
        .execute("UPDATE files SET sha256 = printf('%064d', 1)", [])
        .unwrap();
    drop(connection);

    let recovered = Catalog::open(&catalog_path).unwrap();
    recovered
        .recover_interrupted_operations(&source, SourceKind::Directory)
        .unwrap();
    assert_eq!(recovered.stats().unwrap().scan_status, "resumable");
    assert_eq!(recovered.marked_paths().unwrap().len(), 1);
    let hash_count: i64 = Connection::open(&catalog_path)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM files WHERE sha256 IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(hash_count, 3);
}

#[test]
fn resumes_an_interrupted_directory_scan_from_its_last_path() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let resumed_path = source.join("zz-resume.bin");
    fs::write(&resumed_path, b"resume me").unwrap();
    let catalog_path = temporary.path().join("work/catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    drop(catalog);

    let connection = Connection::open(&catalog_path).unwrap();
    connection
        .execute("DELETE FROM files WHERE path = 'zz-resume.bin'", [])
        .unwrap();
    connection
        .execute(
            "INSERT INTO meta(key, value) VALUES ('scan_status', 'scanning')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO meta(key, value) VALUES ('scan_last_path', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ["Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test/Message Thumbnails/u1/12345678.thumb"],
        )
        .unwrap();
    drop(connection);

    let mut resumed = Catalog::open(&catalog_path).unwrap();
    resumed
        .recover_interrupted_operations(&source, SourceKind::Directory)
        .unwrap();
    assert_eq!(resumed.stats().unwrap().scan_status, "resumable");
    resumed
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    assert_eq!(resumed.stats().unwrap().scan_status, "complete");
    assert_eq!(resumed.stats().unwrap().file_count, 4);
}

#[test]
fn matches_numeric_message_ids_without_casting_the_source_column() {
    let temporary = TempDir::new().unwrap();
    let database_path = temporary.path().join("integer-message-id.sqlite");
    let connection = Connection::open(&database_path).unwrap();
    connection
        .execute_batch(
            "
            CREATE TABLE ZCHAT (
                Z_PK INTEGER PRIMARY KEY,
                ZMID TEXT
            );
            CREATE TABLE ZMESSAGE (
                Z_PK INTEGER PRIMARY KEY,
                ZID INTEGER,
                ZCHAT INTEGER
            );
            INSERT INTO ZCHAT VALUES (7, 'u1');
            INSERT INTO ZMESSAGE VALUES (1, 12345678, 7);
            CREATE INDEX message_id ON ZMESSAGE(ZID);
            ",
        )
        .unwrap();
    connection.close().unwrap();

    let database = LineDatabase::open(&database_path).unwrap();
    let contexts = database
        .attachment_contexts(&["12345678".to_string()])
        .unwrap();
    assert_eq!(contexts["12345678"].len(), 1);
    assert_eq!(contexts["12345678"][0].chat_pk, 7);
}

#[test]
fn pages_chats_and_messages_with_bounded_limits() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let database_path = source.join(inspect_source(&source).unwrap().database_path);
    let connection = Connection::open(&database_path).unwrap();
    connection
        .execute_batch(
            "
            INSERT INTO ZUSER VALUES (3, 'u2', 'Bob');
            INSERT INTO ZUSER VALUES (4, 'u3', 'Carol');
            INSERT INTO ZCHAT VALUES (8, 'u2', 0, 400, 'third');
            INSERT INTO ZCHAT VALUES (9, 'u3', 0, 300, 'third');
            INSERT INTO ZMESSAGE VALUES (5, 'm5', 400, 8, 3, 1, 0, 'R', 'third', NULL, NULL);
            INSERT INTO ZMESSAGE VALUES (6, 'm6', 300, 9, 4, 1, 0, 'R', 'third', NULL, NULL);
            ",
        )
        .unwrap();
    connection.close().unwrap();
    let prepared = prepare_source(&source, &temporary.path().join("work")).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();

    let first_chats = database.list_chats(None, 2).unwrap();
    assert_eq!(first_chats.items.len(), 2);
    assert_eq!(first_chats.items[0].title, "Bob");
    assert!(first_chats.next_cursor.is_some());
    assert!(!first_chats.has_previous);
    let second_chats = database.list_chats(first_chats.next_cursor, 2).unwrap();
    assert_eq!(second_chats.items.len(), 1);
    assert_eq!(second_chats.items[0].title, "Alice");
    assert!(second_chats.next_cursor.is_none());
    assert!(second_chats.has_previous);
    let previous_chats = database
        .list_chats_before(
            ChatCursor {
                last_updated: second_chats.items[0].last_updated,
                source: second_chats.items[0].source.clone(),
                pk: second_chats.items[0].pk,
            },
            2,
        )
        .unwrap();
    assert_eq!(
        previous_chats
            .items
            .iter()
            .map(|chat| chat.title.as_str())
            .collect::<Vec<_>>(),
        ["Bob", "Carol"]
    );
    assert!(!previous_chats.has_previous);

    let chats = database.list_chats(None, 10).unwrap();
    assert_eq!(chats.items.len(), 3);
    assert_eq!(chats.items[2].source, "line");
    assert_eq!(chats.items[2].title, "Alice");
    assert_eq!(chats.items[2].message_count, 4);

    let first = database
        .list_messages_for_account(7, None, 2, prepared.account_id.as_deref())
        .unwrap();
    assert_eq!(first.items.len(), 2);
    assert_eq!(first.items[0].id, "m1");
    assert_eq!(first.items[0].source, "line");
    assert!(!first.items[0].is_self);
    assert!(first.items[1].is_self);
    assert_eq!(
        first.next_cursor,
        Some(MessageCursor {
            timestamp: 100,
            pk: 2
        })
    );
    let second = database.list_messages(7, first.next_cursor, 2).unwrap();
    assert_eq!(
        second
            .items
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        ["m3", "12345678"]
    );
    assert!(second.next_cursor.is_none());
    assert!(second.has_previous);
    let previous = database
        .list_messages_for_account_before(
            7,
            MessageCursor {
                timestamp: second.items[0].timestamp,
                pk: second.items[0].pk,
            },
            2,
            prepared.account_id.as_deref(),
        )
        .unwrap();
    assert_eq!(
        previous
            .items
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        ["m1", "m2"]
    );
    assert!(!previous.has_previous);
    assert!(database.list_messages(7, None, 1_001).is_err());

    let after = ChatCursor {
        last_updated: chats.items[2].last_updated,
        source: chats.items[2].source.clone(),
        pk: chats.items[2].pk,
    };
    assert!(
        database
            .list_chats(Some(after), 10)
            .unwrap()
            .items
            .is_empty()
    );

    let search = database.search_messages("photo", None, None, 1).unwrap();
    assert_eq!(search.items.len(), 1);
    assert_eq!(search.items[0].id, "12345678");
    let contexts = database
        .attachment_contexts(&["12345678".to_string()])
        .unwrap();
    assert_eq!(contexts["12345678"][0].chat_title, "Alice");
    assert_eq!(contexts["12345678"][0].text, "photo context");
    assert!(
        database
            .search_messages(&"x".repeat(1_025), None, None, 10)
            .is_err()
    );
}

#[test]
fn persists_chat_statistics_outside_an_unindexed_read_only_source() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let database_path = source.join(inspect_source(&source).unwrap().database_path);
    let mut connection = Connection::open(&database_path).unwrap();
    connection
        .execute_batch(
            "
            DROP INDEX message_chat_time;
            INSERT INTO ZCHAT VALUES (8, 'unindexed-group', 1, 600, 'latest');
            ",
        )
        .unwrap();
    let transaction = connection.transaction().unwrap();
    {
        let mut insert = transaction
            .prepare(
                "INSERT INTO ZMESSAGE(
                    Z_PK, ZID, ZTIMESTAMP, ZCHAT, ZSENDER, ZSENDSTATUS,
                    ZCONTENTTYPE, ZMESSAGETYPE, ZTEXT, ZLATITUDE, ZLONGITUDE
                 ) VALUES (?1, ?2, ?3, 8, 1, 0, ?4, 'R', ?5, NULL, NULL)",
            )
            .unwrap();
        for offset in 0..10_000_i64 {
            let system_message = offset % 10 == 0;
            insert
                .execute(params![
                    100 + offset,
                    format!("bulk-{offset}"),
                    500 + offset,
                    if system_message { 18 } else { 0 },
                    if system_message {
                        "系統訊息".to_string()
                    } else {
                        format!("message {offset}")
                    }
                ])
                .unwrap();
        }
    }
    transaction.commit().unwrap();
    let source_schema_before = connection
        .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    connection.close().unwrap();

    let work = temporary.path().join("work");
    let prepared = prepare_source(&source, &work).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    assert!(database.is_read_only().unwrap());
    let chats = database.chats_for_index().unwrap();
    let unindexed = chats
        .iter()
        .find(|chat| chat.id == "unindexed-group")
        .unwrap();
    assert_eq!(unindexed.message_count, 10_000);
    assert_eq!(unindexed.human_message_count, 9_000);

    let mut catalog = Catalog::open(&work.join("catalog.sqlite")).unwrap();
    catalog.replace_chat_index(&chats).unwrap();
    let page = catalog.list_indexed_chats(None, None, 1).unwrap();
    assert_eq!(page.items[0].id, "unindexed-group");
    assert!(page.next_cursor.is_some());
    let second = catalog
        .list_indexed_chats(page.next_cursor, None, 1)
        .unwrap();
    assert_eq!(second.items[0].id, "u1");
    assert!(second.has_previous);

    let source_connection = Connection::open(&database_path).unwrap();
    let source_schema_after = source_connection
        .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(source_schema_after, source_schema_before);
}

#[test]
fn chat_backward_pagination_keeps_the_adjacent_page() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let database_path = source.join(inspect_source(&source).unwrap().database_path);
    let connection = Connection::open(&database_path).unwrap();
    connection
        .execute_batch(
            "
            INSERT INTO ZCHAT VALUES
                (8, 'chat-008', 0, 500, 'fifth'),
                (9, 'chat-009', 0, 400, 'fourth'),
                (10, 'chat-010', 0, 300, 'third'),
                (11, 'chat-011', 0, 250, 'before');
            INSERT INTO ZMESSAGE VALUES
                (5, 'm5', 500, 8, 1, 0, 0, 'R', 'fifth', NULL, NULL),
                (6, 'm6', 400, 9, 1, 0, 0, 'R', 'fourth', NULL, NULL),
                (7, 'm7', 300, 10, 1, 0, 0, 'R', 'third', NULL, NULL),
                (8, 'm8', 250, 11, 1, 0, 0, 'R', 'before', NULL, NULL);
            ",
        )
        .unwrap();
    connection.close().unwrap();

    let prepared = prepare_source(&source, &temporary.path().join("work")).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    let first = database.list_chats(None, 2).unwrap();
    let second = database.list_chats(first.next_cursor, 2).unwrap();
    let third = database.list_chats(second.next_cursor, 2).unwrap();

    assert_eq!(
        first
            .items
            .iter()
            .map(|chat| chat.id.as_str())
            .collect::<Vec<_>>(),
        ["chat-008", "chat-009"]
    );
    assert_eq!(
        second
            .items
            .iter()
            .map(|chat| chat.id.as_str())
            .collect::<Vec<_>>(),
        ["chat-010", "chat-011"]
    );
    assert_eq!(third.items[0].id, "u1");
    assert!(third.next_cursor.is_none());
    assert!(third.has_previous);

    let previous = database
        .list_chats_before(
            ChatCursor {
                last_updated: third.items[0].last_updated,
                source: third.items[0].source.clone(),
                pk: third.items[0].pk,
            },
            2,
        )
        .unwrap();
    assert_eq!(
        previous
            .items
            .iter()
            .map(|chat| chat.id.as_str())
            .collect::<Vec<_>>(),
        ["chat-010", "chat-011"]
    );
    assert!(previous.has_previous);

    let forward = database.list_chats(previous.next_cursor, 2).unwrap();
    assert_eq!(forward.items[0].id, "u1");
    assert_eq!(forward.items.len(), 1);
    assert!(forward.next_cursor.is_none());
    assert!(forward.has_previous);
}

#[test]
fn lists_nonempty_system_only_chats_like_the_web_browser() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let database_path = source.join(inspect_source(&source).unwrap().database_path);
    let connection = Connection::open(database_path).unwrap();
    connection
        .execute_batch(
            "
            INSERT INTO ZCHAT VALUES (10, 'system-only', 1, 250, 'system event');
            INSERT INTO ZMESSAGE VALUES
                (10, 'system-event', 250, 10, NULL, 0, 18, 'R',
                 'system event', NULL, NULL);
            ",
        )
        .unwrap();
    connection.close().unwrap();

    let prepared = prepare_source(&source, &temporary.path().join("work")).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    let chats = database.list_chats(None, 10).unwrap();
    let system_only = chats
        .items
        .iter()
        .find(|chat| chat.id == "system-only")
        .unwrap();
    assert_eq!(system_only.message_count, 1);
    assert_eq!(system_only.human_message_count, 0);
}

#[test]
fn resolves_companion_and_rename_titles_and_enriches_message_images() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    add_chat_title_fixtures(&source);
    let work = temporary.path().join("work");
    let prepared = prepare_source(&source, &work).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    let unified_groups =
        UnifiedGroupDatabase::open(prepared.unified_group_database_path.as_deref().unwrap())
            .unwrap();

    let mut chats = database.list_chats(None, 10).unwrap();
    database
        .enrich_chat_titles(&mut chats.items, Some(&unified_groups), None)
        .unwrap();
    let unified = chats
        .items
        .iter()
        .find(|chat| chat.id == "g-unified")
        .unwrap();
    assert_eq!(unified.title, "Unified Room");
    assert_eq!(unified.title_source, "unified-group");
    let renamed = chats
        .items
        .iter()
        .find(|chat| chat.id == "g-renamed")
        .unwrap();
    assert_eq!(renamed.title, "Renamed Room");
    assert_eq!(renamed.title_source, "rename");

    let mut catalog = Catalog::open(&work.join("catalog.sqlite")).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    catalog
        .index_attachment_contexts(&database, None, Some(&unified_groups), |_| {})
        .unwrap();
    let groups = catalog
        .list_cleanup_groups(1, 24, None, "all", "group", "recent")
        .unwrap();
    assert!(
        groups
            .items
            .iter()
            .any(|group| group.chat_title == "Unified Room")
    );

    let mut messages = database.list_messages(8, None, 10).unwrap();
    catalog
        .enrich_messages_with_attachments(&mut messages.items)
        .unwrap();
    assert_eq!(messages.items[0].attachments.len(), 1);
    assert_eq!(
        messages.items[0].attachments[0].kind,
        AttachmentKind::Original
    );
}

#[test]
fn catalogs_attachments_on_disk_and_persists_plan() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let catalog_path = temporary.path().join("work/catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    let stats = catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    assert_eq!(stats.attachment_count, 2);

    let page = catalog
        .list_attachments(None, 10, Some(AttachmentKind::Original), None)
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].message_id, "12345678");
    assert_eq!(page.items[0].chat_hint, "u1");
    catalog.set_marked(&page.items[0].path, true).unwrap();
    assert_eq!(catalog.stats().unwrap().marked_count, 1);
    let advanced = catalog
        .advanced_cleanup_report(0, 0, false, 0, 0, 0)
        .unwrap();
    assert_eq!(advanced.planned_files, 1);
    assert_eq!(advanced.planned_bytes, page.items[0].bytes);
    drop(catalog);

    let catalog = Catalog::open(&catalog_path).unwrap();
    assert!(
        catalog
            .list_attachments(None, 10, None, Some("12345678"))
            .unwrap()
            .items
            .iter()
            .any(|item| item.marked_for_removal)
    );
}

#[test]
fn opening_a_native_session_preserves_persisted_removal_plans() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let work = temporary.path().join("work");
    let prepared = prepare_source(&source, &work).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    let mut catalog = Catalog::open(&work.join("catalog.sqlite")).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    catalog
        .index_attachment_contexts(&database, None, None, |_| {})
        .unwrap();
    let attachment = catalog
        .list_attachments(None, 10, Some(AttachmentKind::Original), None)
        .unwrap()
        .items
        .remove(0);
    catalog.set_marked(&attachment.path, true).unwrap();
    let chat = database.chat_for_cleanup(7).unwrap();
    catalog
        .set_chat_removal_planned(&chat, true, "selected")
        .unwrap();
    drop(catalog);

    let session = NativeSession::open(&source, &work).unwrap();
    drop(session);

    let catalog = Catalog::open(&work.join("catalog.sqlite")).unwrap();
    let marked_paths = catalog.marked_paths().unwrap();
    assert_eq!(marked_paths.len(), 2);
    assert!(marked_paths.contains(&attachment.path));
    let report = catalog
        .advanced_cleanup_report(0, 0, false, 0, 0, 0)
        .unwrap();
    assert_eq!(report.planned_chats, 1);
    assert_eq!(report.planned_database_messages, 4);
    assert_eq!(report.planned_files, 2);
}

#[test]
fn indexes_attachment_contexts_in_large_bounded_batches() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    add_many_attachment_contexts(&source, 901);
    let prepared = prepare_source(&source, &temporary.path().join("work")).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    let mut catalog = Catalog::open(&temporary.path().join("work/catalog.sqlite")).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    let mut progress_reports = Vec::new();
    let progress = catalog
        .index_attachment_contexts(&database, None, None, |update| {
            progress_reports.push(update);
        })
        .unwrap();

    assert_eq!(progress_reports[0].processed_files, 0);
    assert_eq!(progress_reports[0].total_files, 903);
    assert_eq!(progress.total_files, 903);
    assert_eq!(progress.referenced_files, 903);
    assert_eq!(progress.unreferenced_files, 0);
    assert_eq!(progress.unconfirmed_files, 0);
    assert_eq!(progress_reports.len(), 5);
    assert_eq!(progress_reports.last().unwrap().repair_total_files, 0);
}

#[test]
fn repairs_unconfirmed_image_original_from_unique_referenced_thumbnail() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let work = temporary.path().join("repair-context-work");
    let prepared = prepare_source(&source, &work).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    let catalog_path = work.join("catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    catalog
        .index_attachment_contexts(&database, None, None, |_| {})
        .unwrap();
    drop(catalog);

    let connection = Connection::open(&catalog_path).unwrap();
    connection
        .execute(
            "UPDATE files SET
                 message_pk = NULL, message_chat_pk = NULL, message_timestamp = NULL,
                 message_sender_pk = NULL, message_sender_name = NULL,
                 message_content_type = NULL, message_text = NULL, context_source = NULL,
                 context_chat_id = NULL, context_chat_title = NULL, context_chat_kind = NULL,
                 reference_status = 'unconfirmed'
             WHERE attachment_kind = 'original' AND message_id = '12345678'",
            [],
        )
        .unwrap();
    connection.close().unwrap();

    let catalog = Catalog::open(&catalog_path).unwrap();
    assert_eq!(
        catalog
            .repair_image_contexts_from_unique_counterparts()
            .unwrap(),
        1
    );
    let groups = catalog
        .list_cleanup_groups(1, 24, None, "all", "individual", "recent")
        .unwrap();
    assert_eq!(groups.items.len(), 1);
    assert_eq!(groups.items[0].reference_status, "referenced");
    assert_eq!(groups.items[0].thumbnail_backed_image_count, 1);
}

#[test]
fn repairs_community_image_pair_across_container_roots_in_both_directions() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    add_square_fixture(&source);
    let community_thumbnail = source.join(
        "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test/Message Thumbnails/square-chat/23456789.thumb",
    );
    fs::create_dir_all(community_thumbnail.parent().unwrap()).unwrap();
    fs::write(&community_thumbnail, b"community thumbnail").unwrap();

    let work = temporary.path().join("community-repair-work");
    let prepared = prepare_source(&source, &work).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    let square_database =
        LineSquareDatabase::open(prepared.square_database_path.as_deref().unwrap()).unwrap();
    let catalog_path = work.join("catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    catalog
        .index_attachment_contexts(&database, Some(&square_database), None, |_| {})
        .unwrap();
    drop(catalog);

    let clear_context = |kind: &str, status: &str| {
        let connection = Connection::open(&catalog_path).unwrap();
        connection
            .execute(
                "UPDATE files SET
                     message_pk = NULL, message_chat_pk = NULL, message_timestamp = NULL,
                     message_sender_pk = NULL, message_sender_name = NULL,
                     message_content_type = NULL, message_text = NULL, context_source = NULL,
                     context_chat_id = NULL, context_chat_title = NULL, context_chat_kind = NULL,
                     reference_status = ?1
                 WHERE attachment_kind = ?2 AND message_id = '23456789'",
                params![status, kind],
            )
            .unwrap();
        connection.close().unwrap();
    };

    clear_context("original", "unreferenced");
    let catalog = Catalog::open(&catalog_path).unwrap();
    assert_eq!(
        catalog
            .repair_image_contexts_from_unique_counterparts()
            .unwrap(),
        1
    );
    drop(catalog);

    clear_context("thumbnail", "unconfirmed");
    let catalog = Catalog::open(&catalog_path).unwrap();
    assert_eq!(
        catalog
            .repair_image_contexts_from_unique_counterparts()
            .unwrap(),
        1
    );
    let communities = catalog
        .list_cleanup_groups(1, 24, None, "all", "community", "recent")
        .unwrap();
    assert_eq!(communities.items.len(), 1);
    assert_eq!(communities.items[0].chat_id, "square-chat");
    assert_eq!(communities.items[0].thumbnail_backed_image_count, 1);
}

#[test]
fn applies_category_actions_to_individual_group_and_community_files_with_progress() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    add_chat_title_fixtures(&source);
    add_square_fixture(&source);
    let private_store = source.join(
        "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test",
    );
    let group_thumbnail = private_store.join("Message Thumbnails/g-unified/34567890.thumb");
    fs::create_dir_all(group_thumbnail.parent().unwrap()).unwrap();
    fs::write(&group_thumbnail, b"group thumbnail").unwrap();
    let unpaired_group_thumbnail =
        private_store.join("Message Thumbnails/g-unified/44567890.thumb");
    fs::write(&unpaired_group_thumbnail, b"unpaired group thumbnail").unwrap();
    let connection = Connection::open(private_store.join("Messages/Line.sqlite")).unwrap();
    connection
        .execute(
            "INSERT INTO ZMESSAGE VALUES
             (23, '44567890', 420, 8, 1, 0, 1, 'R', 'thumbnail only', NULL, NULL)",
            [],
        )
        .unwrap();
    connection.close().unwrap();
    let community_thumbnail = private_store.join("Message Thumbnails/square-chat/23456789.thumb");
    fs::create_dir_all(community_thumbnail.parent().unwrap()).unwrap();
    fs::write(&community_thumbnail, b"community thumbnail").unwrap();

    let work = temporary.path().join("category-action-work");
    let prepared = prepare_source(&source, &work).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    let square_database =
        LineSquareDatabase::open(prepared.square_database_path.as_deref().unwrap()).unwrap();
    let mut catalog = Catalog::open(&work.join("catalog.sqlite")).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    catalog
        .index_attachment_contexts(&database, Some(&square_database), None, |_| {})
        .unwrap();

    let mut community_progress = Vec::new();
    catalog
        .apply_cleanup_category_action("community", "keep_thumbnail", |progress| {
            community_progress.push(progress);
            Ok(())
        })
        .unwrap();
    assert_eq!(community_progress.first().unwrap().processed_records, 0);
    assert_eq!(community_progress.last().unwrap().processed_records, 1);
    assert_eq!(community_progress.last().unwrap().total_records, 1);

    let mut all_progress = Vec::new();
    let overview = catalog
        .apply_cleanup_category_action("all", "keep_thumbnail", |progress| {
            all_progress.push(progress);
            Ok(())
        })
        .unwrap();
    assert_eq!(all_progress.first().unwrap().processed_records, 0);
    assert_eq!(all_progress.last().unwrap().processed_records, 2);
    assert_eq!(all_progress.last().unwrap().total_records, 2);
    assert_eq!(overview.manual_marked_count, 3);

    let group = catalog
        .list_cleanup_groups(1, 24, None, "all", "group", "recent")
        .unwrap()
        .items
        .into_iter()
        .find(|group| group.chat_id == "g-unified")
        .unwrap();
    assert_eq!(group.thumbnail_backed_image_count, 1);
    assert_eq!(group.nonempty_thumbnail_count, 2);
    assert!(group.keeping_thumbnails);

    let community = catalog
        .list_cleanup_groups(1, 24, None, "all", "community", "recent")
        .unwrap()
        .items
        .into_iter()
        .find(|group| group.chat_id == "square-chat")
        .unwrap();
    assert!(community.keeping_thumbnails);
    let all_action_state = catalog.cleanup_category_action_state("all").unwrap();
    assert!(all_action_state.keeping_all_thumbnails);
    assert!(!all_action_state.deleting_all_attachments);

    let mut clear_thumbnail_progress = Vec::new();
    let overview = catalog
        .apply_cleanup_category_action("all", "clear_keep_thumbnail", |progress| {
            clear_thumbnail_progress.push(progress);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        clear_thumbnail_progress.last().unwrap().processed_records,
        3
    );
    assert_eq!(overview.manual_marked_count, 0);
    assert!(
        !catalog
            .cleanup_category_action_state("all")
            .unwrap()
            .keeping_all_thumbnails
    );

    catalog
        .apply_cleanup_category_action("community", "keep_thumbnail", |_| Ok(()))
        .unwrap();
    let mut delete_progress = Vec::new();
    let overview = catalog
        .apply_cleanup_category_action("community", "delete_all", |progress| {
            delete_progress.push(progress);
            Ok(())
        })
        .unwrap();
    assert_eq!(delete_progress.first().unwrap().processed_records, 0);
    assert_eq!(overview.manual_marked_count, 1);
    let community_state = catalog.cleanup_category_action_state("community").unwrap();
    assert!(community_state.keeping_all_thumbnails);
    assert!(community_state.deleting_all_attachments);
    let community_files = catalog
        .list_cleanup_groups(1, 24, None, "all", "community", "recent")
        .unwrap()
        .items
        .into_iter()
        .find(|group| group.chat_id == "square-chat")
        .unwrap();
    assert_eq!(community_files.marked_count, 1);
    assert!(community_files.deleting_all_attachments);

    let overview = catalog
        .apply_cleanup_group_action(&community_files.key, "toggle_all")
        .unwrap();
    assert_eq!(overview.manual_marked_count, 1);
    let community_state = catalog.cleanup_category_action_state("community").unwrap();
    assert!(community_state.keeping_all_thumbnails);
    assert!(!community_state.deleting_all_attachments);
    catalog
        .apply_cleanup_category_action("community", "clear_keep_thumbnail", |_| Ok(()))
        .unwrap();

    let mut delete_progress = Vec::new();
    let overview = catalog
        .apply_cleanup_category_action("community", "delete_all", |progress| {
            delete_progress.push(progress);
            Ok(())
        })
        .unwrap();
    assert_eq!(delete_progress.last().unwrap().processed_records, 2);
    assert_eq!(delete_progress.last().unwrap().total_records, 2);
    assert_eq!(overview.manual_marked_count, 2);
    catalog
        .apply_cleanup_category_action("community", "keep_thumbnail", |_| Ok(()))
        .unwrap();
    let community_state = catalog.cleanup_category_action_state("community").unwrap();
    assert!(community_state.keeping_all_thumbnails);
    assert!(community_state.deleting_all_attachments);
    assert_eq!(community_state.marked_attachment_count, 1);

    catalog
        .apply_cleanup_category_action("community", "clear_keep_thumbnail", |_| Ok(()))
        .unwrap();
    let community_state = catalog.cleanup_category_action_state("community").unwrap();
    assert!(!community_state.keeping_all_thumbnails);
    assert!(community_state.deleting_all_attachments);
    assert_eq!(community_state.marked_attachment_count, 2);

    let mut clear_attachment_progress = Vec::new();
    let overview = catalog
        .apply_cleanup_category_action("community", "clear_delete_all", |progress| {
            clear_attachment_progress.push(progress);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        clear_attachment_progress.last().unwrap().processed_records,
        2
    );
    assert_eq!(overview.manual_marked_count, 0);
    assert!(
        !catalog
            .cleanup_category_action_state("community")
            .unwrap()
            .deleting_all_attachments
    );

    let community_chats = square_database.all_chats_for_cleanup().unwrap();
    catalog.replace_chat_index(&community_chats).unwrap();
    let mut chat_progress = Vec::new();
    catalog
        .set_chats_removal_planned_reporting(&community_chats, true, "selected", |progress| {
            chat_progress.push(progress);
            Ok(())
        })
        .unwrap();
    assert_eq!(chat_progress.first().unwrap().processed_records, 0);
    assert_eq!(chat_progress.first().unwrap().phase, "整理並寫入聊天室");
    assert_eq!(chat_progress.last().unwrap().phase, "掃描並寫入聊天室附件");
    assert_eq!(
        chat_progress.last().unwrap().processed_records,
        chat_progress.last().unwrap().total_records
    );
    assert_eq!(
        catalog
            .advanced_cleanup_report(0, 0, true, 0, 0, 0)
            .unwrap()
            .planned_chats,
        1
    );
    let community_action_state = catalog.cleanup_category_action_state("community").unwrap();
    assert!(community_action_state.deleting_all_chats);
    assert_eq!(community_action_state.chat_count, 1);

    let mut clear_chat_progress = Vec::new();
    catalog
        .set_chats_removal_planned_reporting(&community_chats, false, "selected", |progress| {
            clear_chat_progress.push(progress);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        clear_chat_progress.first().unwrap().phase,
        "取消聊天室清理計畫"
    );
    assert_eq!(clear_chat_progress.last().unwrap().processed_records, 1);
    assert!(
        !catalog
            .cleanup_category_action_state("community")
            .unwrap()
            .deleting_all_chats
    );
    assert_eq!(
        catalog
            .advanced_cleanup_report(0, 0, true, 0, 0, 0)
            .unwrap()
            .planned_chats,
        0
    );
}

#[test]
fn bulk_chat_removal_reports_staged_progress_without_repeated_attachment_scans() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let prepared = prepare_source(&source, &temporary.path().join("work")).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    let mut catalog = Catalog::open(&temporary.path().join("work/cleanup-catalog.sqlite")).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    catalog
        .index_attachment_contexts(&database, None, None, |_| {})
        .unwrap();

    let chats = (0_i64..1_001)
        .map(|index| Chat {
            pk: 10_000 + index,
            source: "line".to_string(),
            id: format!("bulk-chat-{index}"),
            chat_type: 1,
            kind: "group".to_string(),
            title: format!("大量測試聊天室 {index}"),
            title_source: "fallback".to_string(),
            message_count: index,
            human_message_count: index,
            last_updated: index,
            last_message: String::new(),
            planned_for_removal: false,
        })
        .collect::<Vec<_>>();
    let mut progress = Vec::new();

    catalog
        .set_chats_removal_planned_reporting(&chats, true, "selected", |item| {
            progress.push(item);
            Ok(())
        })
        .unwrap();

    let chat_progress = progress
        .iter()
        .filter(|item| item.phase == "整理並寫入聊天室")
        .map(|item| item.processed_records)
        .collect::<Vec<_>>();
    assert_eq!(chat_progress, vec![0, 500, 1_000, 1_001]);

    let attachment_progress = progress
        .iter()
        .filter(|item| item.phase == "掃描並寫入聊天室附件")
        .collect::<Vec<_>>();
    assert_eq!(attachment_progress.len(), 2);
    assert_eq!(attachment_progress[0].processed_records, 0);
    assert_eq!(
        attachment_progress.last().unwrap().processed_records,
        attachment_progress.last().unwrap().total_records
    );
    assert_eq!(
        catalog
            .advanced_cleanup_report(0, 0, true, 0, 0, 0)
            .unwrap()
            .planned_chats,
        1_001
    );

    let mut clear_progress = Vec::new();
    catalog
        .set_chats_removal_planned_reporting(&chats, false, "selected", |item| {
            clear_progress.push(item);
            Ok(())
        })
        .unwrap();
    let clear_chat_progress = clear_progress
        .iter()
        .filter(|item| item.phase == "取消聊天室清理計畫")
        .map(|item| item.processed_records)
        .collect::<Vec<_>>();
    assert_eq!(clear_chat_progress, vec![0, 500, 1_000, 1_001]);
    assert_eq!(
        catalog
            .advanced_cleanup_report(0, 0, true, 0, 0, 0)
            .unwrap()
            .planned_chats,
        0
    );
}

#[test]
fn cleanup_groups_match_web_reference_and_marking_semantics() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let private_store = source.join(
        "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test",
    );
    let uncertain = private_store.join("Message Attachments/other-chat/12345678.png");
    let unreferenced = private_store.join("Message Attachments/other-chat/87654321.png");
    fs::create_dir_all(uncertain.parent().unwrap()).unwrap();
    fs::write(&uncertain, b"uncertain").unwrap();
    fs::write(&unreferenced, b"unreferenced").unwrap();

    let prepared = prepare_source(&source, &temporary.path().join("work")).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    let mut catalog = Catalog::open(&temporary.path().join("work/cleanup-catalog.sqlite")).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    let progress = catalog
        .index_attachment_contexts(&database, None, None, |_| {})
        .unwrap();
    assert_eq!(progress.referenced_files, 2);
    assert_eq!(progress.unconfirmed_files, 1);
    assert_eq!(progress.unreferenced_files, 1);

    let overview = catalog.cleanup_overview().unwrap();
    let category = |name: &str| {
        overview
            .categories
            .iter()
            .find(|total| total.category == name)
            .unwrap()
            .file_count
    };
    assert_eq!(category("all"), 4);
    assert_eq!(category("individual"), 2);
    assert_eq!(category("unconfirmed"), 1);
    assert_eq!(category("unreferenced"), 1);

    let groups = catalog
        .list_cleanup_groups(1, 24, None, "all", "all", "recent")
        .unwrap();
    assert_eq!(groups.total_items, 3);
    assert_eq!(groups.page_size, 24);
    let referenced_group = groups
        .items
        .iter()
        .find(|group| group.reference_status == "referenced")
        .unwrap();
    assert_eq!(referenced_group.key, "chat:line:7");
    assert!(referenced_group.has_original);
    assert!(referenced_group.has_thumbnail);
    assert_eq!(referenced_group.thumbnail_backed_image_count, 1);
    assert!(!referenced_group.keeping_thumbnails);

    let reviews = catalog
        .list_cleanup_reviews("chat:line:7", 1, 24, None, "all", "all", "recent")
        .unwrap();
    assert_eq!(reviews.total_items, 1);
    assert_eq!(reviews.items[0].files.len(), 2);
    assert_eq!(reviews.items[0].files[0].kind, AttachmentKind::Original);
    assert_eq!(reviews.items[0].files[1].kind, AttachmentKind::Thumbnail);
    assert_eq!(
        reviews.items[0].context.as_ref().unwrap().text,
        "photo context"
    );

    let overview = catalog
        .apply_cleanup_group_action("chat:line:7", "keep_thumbnail")
        .unwrap();
    assert_eq!(overview.marked_count, 1);
    let groups = catalog
        .list_cleanup_groups(1, 24, None, "all", "all", "recent")
        .unwrap();
    assert!(
        groups
            .items
            .iter()
            .find(|group| group.key == "chat:line:7")
            .unwrap()
            .keeping_thumbnails
    );
    let files = catalog
        .list_cleanup_reviews("chat:line:7", 1, 24, None, "all", "all", "recent")
        .unwrap()
        .items
        .remove(0)
        .files;
    assert!(files[0].marked_for_removal);
    assert!(!files[1].marked_for_removal);

    let overview = catalog
        .apply_cleanup_group_action("chat:line:7", "keep_thumbnail")
        .unwrap();
    assert_eq!(overview.marked_count, 0);

    // Keep-thumbnail takes precedence regardless of whether it is enabled before or after
    // delete-all, and each bulk action remains independently reversible.
    let overview = catalog
        .apply_cleanup_group_action("chat:line:7", "keep_thumbnail")
        .unwrap();
    assert_eq!(overview.marked_count, 1);
    let overview = catalog
        .apply_cleanup_group_action("chat:line:7", "toggle_all")
        .unwrap();
    assert_eq!(overview.marked_count, 1);
    let group = catalog
        .list_cleanup_groups(1, 24, None, "all", "all", "recent")
        .unwrap()
        .items
        .into_iter()
        .find(|group| group.key == "chat:line:7")
        .unwrap();
    assert!(group.keeping_thumbnails);
    assert!(group.deleting_all_attachments);

    let overview = catalog
        .apply_cleanup_group_action("chat:line:7", "toggle_all")
        .unwrap();
    assert_eq!(overview.marked_count, 1);
    let group = catalog
        .list_cleanup_groups(1, 24, None, "all", "all", "recent")
        .unwrap()
        .items
        .into_iter()
        .find(|group| group.key == "chat:line:7")
        .unwrap();
    assert!(group.keeping_thumbnails);
    assert!(!group.deleting_all_attachments);

    catalog
        .apply_cleanup_group_action("chat:line:7", "keep_thumbnail")
        .unwrap();
    let overview = catalog
        .apply_cleanup_group_action("chat:line:7", "toggle_all")
        .unwrap();
    assert_eq!(overview.marked_count, 2);
    let overview = catalog
        .apply_cleanup_group_action("chat:line:7", "keep_thumbnail")
        .unwrap();
    assert_eq!(overview.marked_count, 1);
    let files = catalog
        .list_cleanup_reviews("chat:line:7", 1, 24, None, "all", "all", "recent")
        .unwrap()
        .items
        .remove(0)
        .files;
    assert!(files[0].marked_for_removal);
    assert!(!files[1].marked_for_removal);
    let group = catalog
        .list_cleanup_groups(1, 24, None, "all", "all", "recent")
        .unwrap()
        .items
        .into_iter()
        .find(|group| group.key == "chat:line:7")
        .unwrap();
    assert!(group.keeping_thumbnails);
    assert!(group.deleting_all_attachments);

    catalog
        .apply_cleanup_group_action("chat:line:7", "keep_thumbnail")
        .unwrap();
    let overview = catalog
        .apply_cleanup_group_action("chat:line:7", "toggle_all")
        .unwrap();
    assert_eq!(overview.marked_count, 0);
}

#[test]
fn lists_chats_without_indexed_attachments_for_advanced_cleanup() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let database_path = source.join(inspect_source(&source).unwrap().database_path);
    let connection = Connection::open(&database_path).unwrap();
    connection
        .execute_batch(
            "
            INSERT INTO ZUSER VALUES (8, 'u-no-attachments', 'No attachments');
            INSERT INTO ZCHAT VALUES (8, 'u-no-attachments', 0, 400, 'plain message');
            INSERT INTO ZMESSAGE VALUES
                (8, 'm-no-attachments', 400, 8, 8, 0, 0, 'R', 'plain message', NULL, NULL);
            ",
        )
        .unwrap();
    connection.close().unwrap();

    let prepared = prepare_source(&source, &temporary.path().join("work")).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    let mut catalog = Catalog::open(&temporary.path().join("work/catalog.sqlite")).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    catalog
        .index_attachment_contexts(&database, None, None, |_| {})
        .unwrap();

    let page = catalog
        .list_empty_attachment_chats(
            database.all_chats_for_cleanup().unwrap(),
            1,
            24,
            None,
            "all",
            "recent",
        )
        .unwrap();
    assert_eq!(page.total_items, 1);
    assert_eq!(page.items[0].chat_pk, Some(8));
    assert_eq!(page.items[0].reference_status, "no_attachments");
    assert_eq!(page.items[0].file_count, 0);

    let chat = database.chat_for_cleanup(8).unwrap();
    catalog
        .set_chat_removal_planned(&chat, true, "selected")
        .unwrap();
    let page = catalog
        .list_empty_attachment_chats(
            database.all_chats_for_cleanup().unwrap(),
            1,
            24,
            Some("plain"),
            "all",
            "recent",
        )
        .unwrap();
    assert!(page.items[0].planned_for_chat_removal);
}

#[test]
fn keep_thumbnail_protects_all_nonempty_thumbnails_without_requiring_a_pair() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let private_store = source.join(
        "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test",
    );
    let attachments = private_store.join("Message Attachments/u1");
    let thumbnails = private_store.join("Message Thumbnails/u1");

    fs::write(attachments.join("22345678.pdf"), b"pdf").unwrap();
    fs::write(attachments.join("32345678.mp4"), b"video without thumbnail").unwrap();
    fs::write(attachments.join("42345678.jpg"), b"image without thumbnail").unwrap();
    fs::write(attachments.join("52345678.mp4"), b"video with thumbnail").unwrap();
    fs::write(thumbnails.join("52345678.thumb"), b"video thumbnail").unwrap();
    fs::write(
        attachments.join("62345678.jpg"),
        b"image with empty thumbnail",
    )
    .unwrap();
    fs::write(thumbnails.join("62345678.thumb"), b"").unwrap();
    fs::write(
        thumbnails.join("72345678.thumb"),
        b"image thumbnail without original",
    )
    .unwrap();

    let database_path = private_store.join("Messages/Line.sqlite");
    let connection = Connection::open(&database_path).unwrap();
    connection
        .execute_batch(
            "
            INSERT INTO ZMESSAGE VALUES
                (30, '22345678', 310, 7, 1, 0, 14, 'R', 'pdf', NULL, NULL),
                (31, '32345678', 320, 7, 1, 0, 2, 'R', 'video no thumbnail', NULL, NULL),
                (32, '42345678', 330, 7, 1, 0, 1, 'R', 'image no thumbnail', NULL, NULL),
                (33, '52345678', 340, 7, 1, 0, 2, 'R', 'video thumbnail', NULL, NULL),
                (34, '62345678', 350, 7, 1, 0, 1, 'R', 'empty thumbnail', NULL, NULL),
                (35, '72345678', 360, 7, 1, 0, 1, 'R', 'thumbnail without original', NULL, NULL);
            ",
        )
        .unwrap();
    connection.close().unwrap();

    let prepared = prepare_source(&source, &temporary.path().join("work")).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    let catalog_path = temporary.path().join("work/cleanup-safety.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    catalog
        .index_attachment_contexts(&database, None, None, |_| {})
        .unwrap();

    let overview = catalog.cleanup_overview().unwrap();
    assert_eq!(overview.automatic_candidate_count, 1);
    assert_eq!(overview.automatic_marked_count, 0);
    assert_eq!(overview.manual_marked_count, 0);
    let overview = catalog.plan_safe_attachment_cleanup().unwrap();
    assert_eq!(overview.marked_count, 1);
    assert_eq!(overview.automatic_marked_count, 1);
    let auto_file = catalog
        .list_cleanup_reviews("chat:line:7", 1, 24, None, "all", "all", "recent")
        .unwrap()
        .items
        .iter()
        .flat_map(|review| &review.files)
        .find(|file| file.message_id == "12345678" && file.kind == AttachmentKind::Original)
        .unwrap()
        .clone();
    assert_eq!(auto_file.removal_reason, "automatic");
    catalog.set_marked(&auto_file.path, false).unwrap();
    catalog.set_marked(&auto_file.path, true).unwrap();
    let overview = catalog.clear_manual_attachment_plan().unwrap();
    assert_eq!(overview.marked_count, 0);
    assert_eq!(overview.automatic_marked_count, 0);
    let overview = catalog.plan_safe_attachment_cleanup().unwrap();
    assert_eq!(overview.automatic_marked_count, 1);
    let overview = catalog.plan_safe_attachment_cleanup().unwrap();
    assert_eq!(overview.marked_count, 0);

    let group = catalog
        .list_cleanup_groups(1, 24, None, "all", "all", "recent")
        .unwrap()
        .items
        .into_iter()
        .find(|group| group.key == "chat:line:7")
        .unwrap();
    assert_eq!(group.thumbnail_backed_image_count, 1);
    assert_eq!(group.nonempty_thumbnail_count, 3);

    let standalone_thumbnail = catalog
        .list_cleanup_reviews("chat:line:7", 1, 24, None, "all", "all", "recent")
        .unwrap()
        .items
        .iter()
        .flat_map(|review| &review.files)
        .find(|file| file.message_id == "72345678")
        .unwrap()
        .path
        .clone();
    catalog.set_marked(&standalone_thumbnail, true).unwrap();

    let overview = catalog
        .apply_cleanup_group_action("chat:line:7", "keep_thumbnail")
        .unwrap();
    assert_eq!(overview.marked_count, 1);

    let reviews = catalog
        .list_cleanup_reviews("chat:line:7", 1, 24, None, "all", "all", "recent")
        .unwrap();
    let original_mark = |message_id: &str| {
        reviews
            .items
            .iter()
            .find(|review| review.message_id == message_id)
            .unwrap()
            .files
            .iter()
            .find(|file| file.kind == AttachmentKind::Original)
            .unwrap()
            .marked_for_removal
    };
    assert!(original_mark("12345678"));
    assert!(!original_mark("22345678"));
    assert!(!original_mark("32345678"));
    assert!(!original_mark("42345678"));
    assert!(!original_mark("52345678"));
    assert!(!original_mark("62345678"));
    assert!(
        reviews
            .items
            .iter()
            .flat_map(|review| &review.files)
            .all(|file| { file.kind != AttachmentKind::Thumbnail || !file.marked_for_removal })
    );

    catalog
        .apply_cleanup_group_action("chat:line:7", "keep_thumbnail")
        .unwrap();
    catalog
        .apply_cleanup_group_action("chat:line:7", "toggle_all")
        .unwrap();
    catalog
        .apply_cleanup_group_action("chat:line:7", "keep_thumbnail")
        .unwrap();
    let reviews = catalog
        .list_cleanup_reviews("chat:line:7", 1, 24, None, "all", "all", "recent")
        .unwrap();
    for file in reviews.items.iter().flat_map(|review| &review.files) {
        if file.kind == AttachmentKind::Thumbnail && file.bytes > 0 {
            assert!(
                !file.marked_for_removal,
                "{} should be protected",
                file.path
            );
        } else {
            assert!(file.marked_for_removal, "{} should be deleted", file.path);
        }
    }

    drop(catalog);
    let catalog = Catalog::open(&catalog_path).unwrap();
    let group = catalog
        .list_cleanup_groups(1, 24, None, "all", "all", "recent")
        .unwrap()
        .items
        .into_iter()
        .find(|group| group.key == "chat:line:7")
        .unwrap();
    assert!(group.keeping_thumbnails);
    assert!(group.deleting_all_attachments);

    catalog
        .apply_cleanup_group_action("chat:line:7", "keep_thumbnail")
        .unwrap();
    let reviews = catalog
        .list_cleanup_reviews("chat:line:7", 1, 24, None, "all", "all", "recent")
        .unwrap();
    assert!(
        reviews
            .items
            .iter()
            .flat_map(|review| &review.files)
            .all(|file| file.marked_for_removal)
    );
    catalog
        .apply_cleanup_group_action("chat:line:7", "toggle_all")
        .unwrap();

    let overview = catalog.clear_all_user_removal_plans().unwrap();
    assert_eq!(overview.marked_count, 0);
    assert!(catalog.marked_paths().unwrap().is_empty());
}

#[test]
fn cleanup_context_includes_line_square_communities() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    add_square_fixture(&source);
    let prepared = prepare_source(&source, &temporary.path().join("work")).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    let square_database =
        LineSquareDatabase::open(prepared.square_database_path.as_deref().unwrap()).unwrap();
    let chats = square_database.list_chats(None, 10).unwrap();
    assert_eq!(chats.items.len(), 1);
    assert_eq!(chats.items[0].source, "square");
    assert_eq!(chats.items[0].kind, "community");
    assert_eq!(chats.items[0].title, "Square A");
    assert_eq!(chats.items[0].message_count, 2);
    let messages = square_database
        .list_messages(8, None, 10, prepared.account_id.as_deref())
        .unwrap();
    assert_eq!(messages.items.len(), 2);
    assert_eq!(messages.items[0].sender_name, "Square Sender");
    assert!(!messages.items[0].is_self);
    assert!(messages.items[1].is_self);
    let mut catalog = Catalog::open(&temporary.path().join("work/square-catalog.sqlite")).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    catalog
        .index_attachment_contexts(&database, Some(&square_database), None, |_| {})
        .unwrap();

    let overview = catalog.cleanup_overview().unwrap();
    assert_eq!(
        overview
            .categories
            .iter()
            .find(|total| total.category == "community")
            .unwrap()
            .file_count,
        1
    );
    let groups = catalog
        .list_cleanup_groups(1, 24, None, "all", "community", "recent")
        .unwrap();
    assert_eq!(groups.total_items, 1);
    assert_eq!(groups.items[0].chat_title, "Square A");
    assert_eq!(groups.items[0].chat_kind, "community");
    let reviews = catalog
        .list_cleanup_reviews(
            &groups.items[0].key,
            1,
            24,
            None,
            "all",
            "community",
            "recent",
        )
        .unwrap();
    assert_eq!(
        reviews.items[0].context.as_ref().unwrap().sender_name,
        "Square Sender"
    );
}

#[test]
fn stages_only_sqlite_from_imazing_archive() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    add_square_fixture(&source);
    add_chat_title_fixtures(&source);
    let database = inspect_source(&source).unwrap().database_path;
    let square_database = Path::new(&database)
        .with_file_name("LineSquare.sqlite")
        .to_string_lossy()
        .replace('\\', "/");
    let unified_group_database = Path::new(&database)
        .with_file_name("UnifiedGroup.sqlite")
        .to_string_lossy()
        .replace('\\', "/");
    let archive_path = temporary.path().join("LINE.imazingapp");
    let archive_file = fs::File::create(&archive_path).unwrap();
    let mut archive = zip::ZipWriter::new(archive_file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    archive.start_file(&database, options).unwrap();
    let database_bytes = fs::read(source.join(&database)).unwrap();
    archive.write_all(&database_bytes).unwrap();
    archive.start_file(&square_database, options).unwrap();
    archive
        .write_all(&fs::read(source.join(&square_database)).unwrap())
        .unwrap();
    archive
        .start_file(&unified_group_database, options)
        .unwrap();
    archive
        .write_all(&fs::read(source.join(&unified_group_database)).unwrap())
        .unwrap();
    archive
        .start_file(
            "Container/AppGroups/group.com.linecorp.line/Message Attachments/c1/99999999.jpg",
            options,
        )
        .unwrap();
    archive.write_all(b"media should not be staged").unwrap();
    archive.finish().unwrap();

    let report = inspect_source(&archive_path).unwrap();
    assert_eq!(report.kind, SourceKind::ImazingArchive);
    let work = temporary.path().join("work");
    let prepared = prepare_source(&archive_path, &work).unwrap();
    assert!(prepared.database_path.is_file());
    let staged_files = fs::read_dir(prepared.staging_directory.unwrap())
        .unwrap()
        .count();
    assert_eq!(staged_files, 3);
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    assert_eq!(database.list_messages(7, None, 10).unwrap().items.len(), 4);
    assert!(prepared.square_database_path.unwrap().is_file());
    assert!(prepared.unified_group_database_path.unwrap().is_file());
}

#[test]
fn reports_archive_staging_progress_and_reuses_staged_databases() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let database = inspect_source(&source).unwrap().database_path;
    let archive_path = temporary.path().join("LINE.imazingapp");
    write_single_database_archive(&archive_path, &source, &database, b"media payload");
    let database_bytes = fs::metadata(source.join(&database)).unwrap().len();
    let work = temporary.path().join("work");

    let mut events = Vec::new();
    let prepared = prepare_source_reporting(&archive_path, &work, |progress| {
        events.push((progress.phase, progress.staged_bytes, progress.total_bytes));
    })
    .unwrap();
    assert_eq!(events[0].0, PreparePhase::ReadingArchiveIndex);
    let staging: Vec<_> = events
        .iter()
        .filter(|event| event.0 == PreparePhase::StagingDatabases)
        .collect();
    assert!(staging.iter().all(|event| event.2 == database_bytes));
    assert_eq!(staging.last().unwrap().1, database_bytes);
    let staging_directory = prepared.staging_directory.clone().unwrap();

    let mut reused_events = Vec::new();
    let reused = prepare_source_reporting(&archive_path, &work, |progress| {
        reused_events.push((progress.phase, progress.staged_bytes, progress.total_bytes));
    })
    .unwrap();
    assert_eq!(reused.staging_directory.unwrap(), staging_directory);
    assert!(
        reused_events
            .iter()
            .filter(|event| event.0 == PreparePhase::StagingDatabases)
            .all(|event| event.1 == 0 && event.2 == 0)
    );

    write_single_database_archive(&archive_path, &source, &database, b"replaced media payload");
    let changed = prepare_source_reporting(&archive_path, &work, |_| {}).unwrap();
    assert_ne!(changed.staging_directory.unwrap(), staging_directory);
}

fn write_single_database_archive(
    archive_path: &Path,
    source: &Path,
    database: &str,
    media_payload: &[u8],
) {
    let archive_file = fs::File::create(archive_path).unwrap();
    let mut archive = zip::ZipWriter::new(archive_file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    archive.start_file(database, options).unwrap();
    archive
        .write_all(&fs::read(source.join(database)).unwrap())
        .unwrap();
    archive
        .start_file(
            "Container/AppGroups/group.com.linecorp.line/Message Attachments/c1/99999999.jpg",
            options,
        )
        .unwrap();
    archive.write_all(media_payload).unwrap();
    archive.finish().unwrap();
}

#[test]
fn stages_bounded_image_previews_from_directory_and_archive() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let catalog_path = temporary.path().join("directory-work/catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    let original = catalog
        .list_attachments(None, 10, Some(AttachmentKind::Original), None)
        .unwrap()
        .items
        .remove(0);
    let preview = catalog
        .stage_attachment_preview(&source, SourceKind::Directory, &original.path)
        .unwrap();
    assert_eq!(preview.media_type, "image/jpeg");
    assert_eq!(preview.bytes, original.bytes);
    assert!(Path::new(&preview.staged_path).is_file());

    let database = inspect_source(&source).unwrap().database_path;
    let archive_path = temporary.path().join("LINE.imazingapp");
    let archive_file = fs::File::create(&archive_path).unwrap();
    let mut archive = zip::ZipWriter::new(archive_file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    archive.start_file(&database, options).unwrap();
    archive
        .write_all(&fs::read(source.join(&database)).unwrap())
        .unwrap();
    archive.start_file(&original.path, options).unwrap();
    archive
        .write_all(&fs::read(source.join(&original.path)).unwrap())
        .unwrap();
    archive.finish().unwrap();

    let archive_catalog_path = temporary.path().join("archive-work/catalog.sqlite");
    let mut archive_catalog = Catalog::open(&archive_catalog_path).unwrap();
    archive_catalog
        .scan_source(&archive_path, SourceKind::ImazingArchive, |_| {})
        .unwrap();
    let preview = archive_catalog
        .stage_attachment_preview(&archive_path, SourceKind::ImazingArchive, &original.path)
        .unwrap();
    assert_eq!(preview.media_type, "image/jpeg");
    assert_eq!(
        fs::read(&preview.staged_path).unwrap(),
        b"\xff\xd8\xffimage123"
    );
    assert!(
        Path::new(&preview.staged_path)
            .parent()
            .unwrap()
            .ends_with("preview-cache")
    );
}

#[test]
fn exports_selected_images_from_directory_and_archive_without_overwriting_source() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let catalog_path = temporary.path().join("directory-export/catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    let attachments = catalog
        .list_attachments(None, 10, None, None)
        .unwrap()
        .items;
    let paths = attachments
        .iter()
        .map(|attachment| attachment.path.clone())
        .collect::<Vec<_>>();
    let export_root = temporary.path().join("exports");
    fs::create_dir_all(&export_root).unwrap();
    let output = export_root.join("LINE-Cheater-Export");
    let mut progress = Vec::new();
    let report = catalog
        .export_attachments(
            &source,
            SourceKind::Directory,
            ExportScope::Paths(&paths),
            &output,
            ExportOptions {
                images_only: true,
                include_thumbnails: true,
            },
            |value| progress.push(value),
        )
        .unwrap();
    assert_eq!(report.exported_files, 2);
    assert_eq!(report.skipped_files, 0);
    assert!(output.join("12345678.jpg").is_file());
    assert!(output.join("12345678.thumb").is_file());
    assert_eq!(
        fs::read(output.join("12345678.jpg")).unwrap(),
        b"\xff\xd8\xffimage123"
    );
    assert_eq!(
        fs::read(output.join("12345678.thumb")).unwrap(),
        b"\x89PNG\r\n\x1a\n"
    );
    assert!(!output.with_extension("partial").exists());
    assert_eq!(progress.last().unwrap().processed_files, 2);

    let inside_source = source.join("export-inside");
    assert!(
        catalog
            .export_attachments(
                &source,
                SourceKind::Directory,
                ExportScope::Paths(&paths),
                &inside_source,
                ExportOptions {
                    images_only: false,
                    include_thumbnails: false,
                },
                |_| {},
            )
            .is_err()
    );
    assert!(
        catalog
            .export_attachments(
                &source,
                SourceKind::Sqlite,
                ExportScope::Paths(&paths),
                &export_root.join("sqlite-export"),
                ExportOptions {
                    images_only: false,
                    include_thumbnails: false,
                },
                |_| {},
            )
            .is_err()
    );

    let database = inspect_source(&source).unwrap().database_path;
    let archive_path = temporary.path().join("LINE-export.imazingapp");
    let archive_file = fs::File::create(&archive_path).unwrap();
    let mut archive = zip::ZipWriter::new(archive_file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    archive.start_file(&database, options).unwrap();
    archive
        .write_all(&fs::read(source.join(&database)).unwrap())
        .unwrap();
    for path in &paths {
        archive.start_file(path, options).unwrap();
        archive
            .write_all(&fs::read(source.join(path)).unwrap())
            .unwrap();
    }
    archive.finish().unwrap();

    let archive_catalog_path = temporary.path().join("archive-export/catalog.sqlite");
    let mut archive_catalog = Catalog::open(&archive_catalog_path).unwrap();
    archive_catalog
        .scan_source(&archive_path, SourceKind::ImazingArchive, |_| {})
        .unwrap();
    let archive_output = export_root.join("archive-export");
    let archive_report = archive_catalog
        .export_attachments(
            &archive_path,
            SourceKind::ImazingArchive,
            ExportScope::Paths(&paths),
            &archive_output,
            ExportOptions {
                images_only: true,
                include_thumbnails: false,
            },
            |_| {},
        )
        .unwrap();
    assert_eq!(archive_report.exported_files, 1);
    assert!(archive_output.join("12345678.jpg").is_file());
    assert!(!archive_output.join("12345678.thumb").exists());
    assert!(source.join(&database).is_file());
}

#[test]
fn sidecar_protocol_returns_bounded_pages_and_structured_errors() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    add_square_fixture(&source);
    let work = temporary.path().join("work");
    let mut session = NativeSession::open(&source, &work).unwrap();
    let requests = concat!(
        "{\"id\":\"0\",\"method\":\"sessionInfo\"}\n",
        "{\"id\":\"1\",\"method\":\"listChats\",\"params\":{\"limit\":1}}\n",
        "{\"id\":\"2\",\"method\":\"listMessages\",\"params\":{\"chatPk\":7,\"limit\":2}}\n",
        "{\"id\":\"3\",\"method\":\"searchMessages\",\"params\":{\"query\":\"photo\",\"limit\":10}}\n",
        "{\"id\":\"4\",\"method\":\"listMessages\",\"params\":{\"chatPk\":7,\"limit\":1001}}\n",
        "{\"id\":\"5\",\"jobId\":\"scan-job\",\"method\":\"scanCatalog\"}\n",
        "{\"id\":\"6\",\"method\":\"listAttachments\",\"params\":{\"limit\":10}}\n",
        "{\"id\":\"7\",\"method\":\"stageAttachmentPreview\",\"params\":{\"path\":\"Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test/Message Attachments/u1/12345678.jpg\"}}\n",
        "{\"id\":\"9\",\"method\":\"listMessages\",\"params\":{\"chatPk\":7,\"limit\":10}}\n",
        "{\"id\":\"10\",\"method\":\"listChats\",\"params\":{\"limit\":10}}\n",
        "{\"id\":\"11\",\"method\":\"listMessages\",\"params\":{\"source\":\"square\",\"chatPk\":8,\"limit\":10}}\n",
        "{\"id\":\"12\",\"method\":\"listMessages\",\"params\":{\"chatPk\":7,\"limit\":2,\"cursor\":{\"timestamp\":100,\"pk\":2}}}\n",
        "{\"id\":\"13\",\"method\":\"listMessages\",\"params\":{\"chatPk\":7,\"limit\":2,\"beforeCursor\":{\"timestamp\":200,\"pk\":3}}}\n",
        "{\"id\":\"14\",\"method\":\"listChats\",\"params\":{\"limit\":1,\"beforeCursor\":{\"lastUpdated\":200,\"source\":\"line\",\"pk\":7}}}\n",
        "{\"id\":\"15\",\"method\":\"advancedCleanupReport\"}\n",
        "{\"id\":\"16\",\"method\":\"setChatRemovalPlanned\",\"params\":{\"source\":\"line\",\"chatPk\":7,\"planned\":true}}\n",
        "{\"id\":\"17\",\"method\":\"sessionInfo\"}\n",
        "{\"id\":\"18\",\"method\":\"listChats\",\"params\":{\"limit\":1,\"cursor\":{\"lastUpdated\":410,\"source\":\"square\",\"pk\":8}}}\n",
        "{\"id\":\"19\",\"method\":\"listChats\",\"params\":{\"limit\":1,\"beforeCursor\":{\"lastUpdated\":200,\"source\":\"line\",\"pk\":7}}}\n",
        "{\"id\":\"20\",\"method\":\"listChats\",\"params\":{\"limit\":1,\"cursor\":{\"lastUpdated\":410,\"source\":\"square\",\"pk\":8}}}\n",
        "{\"id\":\"21\",\"method\":\"searchMessages\",\"params\":{\"query\":\"photo\",\"limit\":10}}\n",
        "{\"id\":\"22\",\"method\":\"cleanupPreflight\"}\n",
        "{\"id\":\"23\",\"method\":\"cleanupPlanPreviews\"}\n",
        "{\"id\":\"24\",\"method\":\"cleanupAudit\",\"params\":{\"limit\":20}}\n",
        "{\"id\":\"25\",\"method\":\"cleanupPreflight\",\"params\":{\"verifySource\":false}}\n",
        "{\"id\":\"8\",\"method\":\"shutdown\"}\n"
    );
    let mut input = std::io::BufReader::new(requests.as_bytes());
    let mut output = Vec::new();
    serve(&mut session, &mut input, &mut output).unwrap();
    let rows: Vec<serde_json::Value> = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows[0]["event"], "ready");
    let response = |id: &str| {
        rows.iter()
            .find(|row| row["id"] == id)
            .expect("response ID exists")
    };
    assert_eq!(response("0")["result"]["quickCheck"], "ok");
    assert_eq!(response("0")["result"]["fts5Available"], true);
    assert!(
        response("0")["result"]["performance"]["logicalCpus"]
            .as_u64()
            .unwrap()
            >= 1
    );
    assert!(
        response("0")["result"]["performance"]["archiveWorkers"]
            .as_u64()
            .unwrap()
            >= 1
    );
    assert_eq!(response("0")["result"]["catalogSourceCurrent"], false);
    assert_eq!(
        response("1")["result"]["items"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        response("2")["result"]["items"].as_array().unwrap().len(),
        2
    );
    assert_eq!(response("2")["result"]["items"][0]["isSelf"], false);
    assert_eq!(response("2")["result"]["items"][1]["isSelf"], true);
    assert_eq!(response("3")["result"]["items"][0]["id"], "12345678");
    assert_eq!(response("4")["ok"], false);
    assert_eq!(response("4")["error"]["code"], "operation_failed");
    assert_eq!(response("5")["jobId"], "scan-job");
    let attachment = response("6")["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["messageId"] == "12345678")
        .expect("linked attachment exists");
    assert_eq!(attachment["context"]["text"], "photo context");
    assert_eq!(response("7")["result"]["mediaType"], "image/jpeg");
    let photo_message = response("9")["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "12345678")
        .unwrap();
    assert_eq!(photo_message["attachments"].as_array().unwrap().len(), 2);
    let chats = response("10")["result"]["items"].as_array().unwrap();
    assert!(
        chats
            .iter()
            .any(|chat| chat["source"] == "square" && chat["kind"] == "community")
    );
    let square_messages = response("11")["result"]["items"].as_array().unwrap();
    assert_eq!(square_messages.len(), 2);
    assert_eq!(square_messages[0]["source"], "square");
    assert_eq!(square_messages[0]["isSelf"], false);
    assert_eq!(square_messages[1]["isSelf"], true);
    assert_eq!(response("12")["result"]["items"][0]["id"], "m3");
    assert_eq!(
        response("12")["result"]["nextCursor"],
        serde_json::Value::Null
    );
    assert_eq!(response("12")["result"]["hasPrevious"], true);
    assert_eq!(response("13")["result"]["items"][0]["id"], "m1");
    assert_eq!(response("13")["result"]["hasPrevious"], false);
    assert_eq!(response("14")["result"]["items"][0]["source"], "square");
    assert_eq!(response("15")["result"]["plannedChats"], 0);
    assert_eq!(response("16")["result"]["plannedChats"], 1);
    assert_eq!(response("16")["result"]["plannedFiles"], 2);
    assert_eq!(response("17")["result"]["quickCheck"], "ok");
    assert_eq!(response("18")["result"]["items"][0]["source"], "line");
    assert_eq!(
        response("18")["result"]["nextCursor"],
        serde_json::Value::Null
    );
    assert_eq!(response("19")["result"]["items"][0]["source"], "square");
    assert_eq!(response("19")["result"]["hasPrevious"], false);
    assert_eq!(response("20")["result"]["items"][0]["source"], "line");
    assert_eq!(response("21")["result"]["items"][0]["id"], "12345678");
    assert_eq!(response("22")["result"]["blockerCount"], 0);
    assert_eq!(response("22")["result"]["sqliteQuickCheck"], "ok");
    assert_eq!(response("22")["result"]["scanStatus"], "complete");
    assert_eq!(response("22")["result"]["safeCandidateCount"], 1);
    assert_eq!(response("23")["result"].as_array().unwrap().len(), 3);
    assert_eq!(response("23")["result"][0]["profile"], "conservative");
    assert_eq!(response("23")["result"][1]["reviewFileCount"], 0);
    assert_eq!(response("24")["result"]["plan"]["plannedChatCount"], 1);
    assert_eq!(
        response("24")["result"]["plan"]["planFingerprint"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    assert!(
        !response("24")["result"]["events"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(response("25")["result"]["blockerCount"], 0);
    assert_eq!(response("25")["result"]["catalogSourceCurrent"], true);
    let indexed_messages: i64 = Connection::open(work.join("search.sqlite"))
        .unwrap()
        .query_row("SELECT COUNT(*) FROM messages_fts", [], |row| row.get(0))
        .unwrap();
    assert!(indexed_messages > 0);
    let indexed_chats: i64 = Connection::open(work.join("catalog.sqlite"))
        .unwrap()
        .query_row("SELECT COUNT(*) FROM chats", [], |row| row.get(0))
        .unwrap();
    assert_eq!(indexed_chats, 2);
    assert_eq!(response("8")["result"]["shuttingDown"], true);
}

#[test]
fn builds_valid_directory_candidate_without_marked_attachment() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let catalog_path = temporary.path().join("work/catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    let thumbnail = catalog
        .list_attachments(None, 10, Some(AttachmentKind::Thumbnail), None)
        .unwrap()
        .items
        .remove(0);
    catalog.set_marked(&thumbnail.path, true).unwrap();

    let output = temporary.path().join("LINE-slim.imazingapp");
    let report = build_candidate(&source, &output, &catalog, true, false, |_| Ok(())).unwrap();
    assert_eq!(report.removed_entries, 1);
    assert!(report.full_crc_verified);
    assert!(!output.with_extension("imazingapp.partial").exists());
    let file = fs::File::open(output).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    assert!(archive.by_name(&thumbnail.path).is_err());
    assert!(
        archive
            .file_names()
            .any(|name| name.ends_with("/Messages/Line.sqlite"))
    );
}

#[test]
fn advanced_cleanup_rewrites_candidate_sqlite_and_removes_chat_files_only() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    add_square_fixture(&source);
    let path_only_chat_file = "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test/Message Attachments/u1/87654321.bin";
    fs::write(source.join(path_only_chat_file), b"path-only chat file").unwrap();
    let report = inspect_source(&source).unwrap();
    let line_path = source.join(&report.database_path);
    let square_path = line_path.with_file_name("LineSquare.sqlite");

    let connection = Connection::open(&line_path).unwrap();
    connection
        .execute_batch(
            "
            INSERT INTO ZCHAT VALUES (10, 'empty-line', 1, 0, '');
            INSERT INTO ZCHAT VALUES (11, 'system-line', 1, 350, 'system');
            INSERT INTO ZMESSAGE VALUES
                (30, 'line-system-event', 350, 11, NULL, 0, 18, 'R',
                 'system event', NULL, NULL);
            ",
        )
        .unwrap();
    connection.close().unwrap();

    let connection = Connection::open(&square_path).unwrap();
    connection
        .execute_batch(
            "
            INSERT INTO ZCHAT VALUES (9, 'empty-square', 0, 3, '');
            INSERT INTO ZCHAT VALUES (10, 'system-square', 0, 3, 'system');
            INSERT INTO ZMESSAGE VALUES
                (14, 'square-orphan', 420, 999, 11, 1, 0, 'R',
                 'orphan message', NULL, NULL),
                (15, 'square-system-event', 430, 10, 11, 1, 18, 'R',
                 'system event', NULL, NULL);
            ",
        )
        .unwrap();
    connection.close().unwrap();

    let original_line = fs::read(&line_path).unwrap();
    let original_square = fs::read(&square_path).unwrap();
    let work = temporary.path().join("advanced-work");
    let prepared = prepare_source(&source, &work).unwrap();
    let database = LineDatabase::open(&prepared.database_path).unwrap();
    let square_database =
        LineSquareDatabase::open(prepared.square_database_path.as_deref().unwrap()).unwrap();
    let mut catalog = Catalog::open(&work.join("catalog.sqlite")).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    catalog
        .index_attachment_contexts(&database, Some(&square_database), None, |_| {})
        .unwrap();

    let selected = database.chat_for_cleanup(7).unwrap();
    catalog
        .set_chat_removal_planned(&selected, true, "selected")
        .unwrap();
    let mut filtered = database.advanced_cleanup_chats().unwrap();
    filtered.extend(square_database.advanced_cleanup_chats().unwrap());
    let orphans = square_database.orphan_messages().unwrap();
    assert_eq!(orphans.len(), 1);
    catalog.plan_automatic_cleanup(&filtered, &orphans).unwrap();
    let planned_group = catalog
        .list_cleanup_groups(1, 24, None, "all", "all", "recent")
        .unwrap()
        .items
        .into_iter()
        .find(|group| group.key == "chat:line:7")
        .unwrap();
    assert_eq!(planned_group.chat_source, "line");
    assert_eq!(planned_group.chat_pk, Some(7));
    assert!(planned_group.planned_for_chat_removal);
    let advanced = catalog
        .advanced_cleanup_report(1, 1, true, 1, 1, 1)
        .unwrap();
    assert!(advanced.automatic_cleanup_planned);
    assert_eq!(advanced.planned_chats, 5);
    assert_eq!(advanced.planned_database_messages, 7);
    assert_eq!(advanced.planned_files, 3);

    let output = temporary.path().join("LINE-advanced.imazingapp");
    let candidate = build_candidate(&source, &output, &catalog, true, false, |_| Ok(())).unwrap();
    assert_eq!(candidate.removed_chats, 5);
    assert_eq!(candidate.removed_messages, 7);
    assert_eq!(candidate.rewritten_databases.len(), 2);
    assert_eq!(fs::read(&line_path).unwrap(), original_line);
    assert_eq!(fs::read(&square_path).unwrap(), original_square);

    let mut archive = zip::ZipArchive::new(fs::File::open(&output).unwrap()).unwrap();
    let marked = catalog.marked_paths().unwrap();
    let attachment = catalog
        .list_attachments(None, 10, Some(AttachmentKind::Original), None)
        .unwrap()
        .items
        .into_iter()
        .find(|item| marked.contains(&item.path))
        .unwrap();
    assert!(archive.by_name(&attachment.path).is_err());
    assert!(archive.by_name(path_only_chat_file).is_err());

    let extracted_line = temporary.path().join("candidate-Line.sqlite");
    {
        let mut entry = archive.by_name(&report.database_path).unwrap();
        let mut output = fs::File::create(&extracted_line).unwrap();
        std::io::copy(&mut entry, &mut output).unwrap();
    }
    let square_entry = report
        .database_path
        .rsplit_once('/')
        .map(|(parent, _)| format!("{parent}/LineSquare.sqlite"))
        .unwrap();
    let extracted_square = temporary.path().join("candidate-LineSquare.sqlite");
    {
        let mut entry = archive.by_name(&square_entry).unwrap();
        let mut output = fs::File::create(&extracted_square).unwrap();
        std::io::copy(&mut entry, &mut output).unwrap();
    }

    let connection = Connection::open(extracted_line).unwrap();
    let line_chats: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM ZCHAT WHERE Z_PK IN (7, 10, 11)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let line_messages: i64 = connection
        .query_row("SELECT COUNT(*) FROM ZMESSAGE", [], |row| row.get(0))
        .unwrap();
    assert_eq!(line_chats, 0);
    assert_eq!(line_messages, 0);
    connection.close().unwrap();

    let connection = Connection::open(extracted_square).unwrap();
    let retained_chat: i64 = connection
        .query_row("SELECT COUNT(*) FROM ZCHAT WHERE Z_PK = 8", [], |row| {
            row.get(0)
        })
        .unwrap();
    let removed_square_chats: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM ZCHAT WHERE Z_PK IN (9, 10)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let orphan: i64 = connection
        .query_row("SELECT COUNT(*) FROM ZMESSAGE WHERE Z_PK = 14", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(retained_chat, 1);
    assert_eq!(removed_square_chats, 0);
    assert_eq!(orphan, 0);
    connection.close().unwrap();

    catalog.plan_automatic_cleanup(&filtered, &orphans).unwrap();
    let advanced = catalog
        .advanced_cleanup_report(1, 1, true, 1, 1, 1)
        .unwrap();
    assert!(!advanced.automatic_cleanup_planned);
    assert_eq!(advanced.planned_chats, 1);
    assert_eq!(advanced.planned_database_messages, 4);
    assert_eq!(advanced.planned_files, 3);
}

#[test]
fn corrupt_line_square_is_replaced_with_an_empty_database() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    add_square_fixture(&source);
    corrupt_square_index(&source);
    let report = inspect_source(&source).unwrap();
    let square_path = source
        .join(&report.database_path)
        .with_file_name("LineSquare.sqlite");
    let corrupt_check: String = Connection::open(&square_path)
        .unwrap()
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .unwrap();
    assert_ne!(corrupt_check, "ok");

    let work = temporary.path().join("corrupt-square-work");
    let prepared = prepare_source(&source, &work).unwrap();
    let square_database =
        LineSquareDatabase::open(prepared.square_database_path.as_deref().unwrap()).unwrap();
    let selected = square_database.chat_for_cleanup(8).unwrap();
    let catalog_path = work.join("catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    catalog
        .set_chat_removal_planned(&selected, true, "selected")
        .unwrap();

    let output = temporary.path().join("LINE-corrupt-square.imazingapp");
    let error = build_candidate(&source, &output, &catalog, true, false, |_| Ok(())).unwrap_err();
    assert!(line_square_rebuild_required(&error));
    assert!(!output.exists());

    let candidate = build_candidate_with_options(
        &source,
        &output,
        &catalog,
        CandidateOptions {
            full_crc: true,
            link_duplicates: false,
            allow_corrupt_line_square_rebuild: true,
        },
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(candidate.rewritten_databases.len(), 1);
    assert!(
        candidate
            .warnings
            .iter()
            .any(|warning| warning.contains("LineSquare.sqlite") && warning.contains("空白"))
    );

    let square_entry = report
        .database_path
        .rsplit_once('/')
        .map(|(parent, _)| format!("{parent}/LineSquare.sqlite"))
        .unwrap();
    let extracted_square = temporary.path().join("candidate-empty-LineSquare.sqlite");
    let mut archive = zip::ZipArchive::new(fs::File::open(&output).unwrap()).unwrap();
    {
        let mut entry = archive.by_name(&square_entry).unwrap();
        let mut output = fs::File::create(&extracted_square).unwrap();
        std::io::copy(&mut entry, &mut output).unwrap();
    }
    let connection = Connection::open(&extracted_square).unwrap();
    let quick_check: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .unwrap();
    let chats: i64 = connection
        .query_row("SELECT COUNT(*) FROM ZCHAT", [], |row| row.get(0))
        .unwrap();
    let messages: i64 = connection
        .query_row("SELECT COUNT(*) FROM ZMESSAGE", [], |row| row.get(0))
        .unwrap();
    assert_eq!(quick_check, "ok");
    assert_eq!(chats, 0);
    assert_eq!(messages, 0);
    connection.close().unwrap();

    let original_check: String = Connection::open(&square_path)
        .unwrap()
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .unwrap();
    assert_ne!(original_check, "ok");
}

#[test]
fn raw_copies_archive_candidate_and_removes_marked_entry() {
    let temporary = TempDir::new().unwrap();
    let source_directory = make_fixture(temporary.path());
    let database = inspect_source(&source_directory).unwrap().database_path;
    let removable =
        "Container/AppGroups/group.com.linecorp.line/Message Thumbnails/c1/99999999.thumb";
    let archive_path = temporary.path().join("LINE.imazingapp");
    let archive_file = fs::File::create(&archive_path).unwrap();
    let mut writer = zip::ZipWriter::new(archive_file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    writer.start_file(".lock", options).unwrap();
    writer.write_all(b"lock").unwrap();
    writer
        .start_file("Payload/LINE.app/Info.plist", options)
        .unwrap();
    writer.write_all(b"plist").unwrap();
    writer.start_file(&database, options).unwrap();
    writer
        .write_all(&fs::read(source_directory.join(&database)).unwrap())
        .unwrap();
    writer.start_file(removable, options).unwrap();
    writer.write_all(b"remove me").unwrap();
    writer.finish().unwrap();

    let catalog_path = temporary.path().join("archive-work/catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&archive_path, SourceKind::ImazingArchive, |_| {})
        .unwrap();
    catalog.set_marked(removable, true).unwrap();
    let output = temporary.path().join("LINE-raw-copy.imazingapp");
    let report =
        build_candidate(&archive_path, &output, &catalog, true, false, |_| Ok(())).unwrap();
    assert_eq!(report.removed_entries, 1);
    assert_eq!(report.input_entries - report.output_entries, 1);
    let mut archive = zip::ZipArchive::new(fs::File::open(output).unwrap()).unwrap();
    assert!(archive.by_name(removable).is_err());
    let mut lock = Vec::new();
    archive
        .by_name(".lock")
        .unwrap()
        .read_to_end(&mut lock)
        .unwrap();
    assert_eq!(lock, b"lock");
}

#[test]
fn writes_relative_duplicate_symlinks_into_archive_candidates() {
    let temporary = TempDir::new().unwrap();
    let source_directory = make_fixture(temporary.path());
    let database = inspect_source(&source_directory).unwrap().database_path;
    let private_store = "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test";
    let canonical_path = format!("{private_store}/Message Attachments/c010/91000001.bin");
    let linked_path = format!("{private_store}/Message Thumbnails/c020/91000002.thumb");
    let archive_path = temporary.path().join("LINE-duplicates.imazingapp");
    let mut writer = zip::ZipWriter::new(fs::File::create(&archive_path).unwrap());
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let database_bytes = fs::read(source_directory.join(&database)).unwrap();
    for (name, bytes) in [
        (".lock", b"lock".as_slice()),
        ("Payload/LINE.app/Info.plist", b"plist".as_slice()),
        (database.as_str(), database_bytes.as_slice()),
        (&canonical_path, b"archive duplicate".as_slice()),
        (&linked_path, b"archive duplicate".as_slice()),
    ] {
        writer.start_file(name, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();

    let catalog_path = temporary.path().join("archive-link-work/catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&archive_path, SourceKind::ImazingArchive, |_| {})
        .unwrap();
    catalog
        .hash_duplicate_candidates(&archive_path, SourceKind::ImazingArchive, |_| Ok(()))
        .unwrap();

    let output = temporary.path().join("LINE-duplicates-linked.imazingapp");
    let report = build_candidate(&archive_path, &output, &catalog, true, true, |_| Ok(())).unwrap();
    assert_eq!(report.linked_duplicate_entries, 1);
    let mut archive = zip::ZipArchive::new(fs::File::open(output).unwrap()).unwrap();
    assert!(!archive.by_name(&canonical_path).unwrap().is_symlink());
    let mut link = archive.by_name(&linked_path).unwrap();
    assert!(link.is_symlink());
    let mut target = String::new();
    link.read_to_string(&mut target).unwrap();
    assert_eq!(target, "../../Message Attachments/c010/91000001.bin");
}

#[test]
fn keeps_archive_directory_entries_in_candidate() {
    let temporary = TempDir::new().unwrap();
    let source_directory = make_fixture(temporary.path());
    let database = inspect_source(&source_directory).unwrap().database_path;
    let removable =
        "Container/AppGroups/group.com.linecorp.line/Message Thumbnails/c1/99999999.thumb";
    let archive_path = temporary.path().join("LINE-directories.imazingapp");
    let mut writer = zip::ZipWriter::new(fs::File::create(&archive_path).unwrap());
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    writer.add_directory("Payload/", options).unwrap();
    writer.add_directory("Payload/LINE.app/", options).unwrap();
    writer.start_file(".lock", options).unwrap();
    writer.write_all(b"lock").unwrap();
    writer
        .start_file("Payload/LINE.app/Info.plist", options)
        .unwrap();
    writer.write_all(b"plist").unwrap();
    writer.start_file(&database, options).unwrap();
    writer
        .write_all(&fs::read(source_directory.join(&database)).unwrap())
        .unwrap();
    writer.start_file(removable, options).unwrap();
    writer.write_all(b"remove me").unwrap();
    writer.finish().unwrap();

    let mut catalog =
        Catalog::open(&temporary.path().join("directory-work/catalog.sqlite")).unwrap();
    catalog
        .scan_source(&archive_path, SourceKind::ImazingArchive, |_| {})
        .unwrap();
    catalog.set_marked(removable, true).unwrap();
    let output = temporary
        .path()
        .join("LINE-directories-candidate.imazingapp");
    let report =
        build_candidate(&archive_path, &output, &catalog, true, false, |_| Ok(())).unwrap();
    assert_eq!(report.removed_entries, 1);
    assert_eq!(report.input_entries - report.output_entries, 1);

    let mut archive = zip::ZipArchive::new(fs::File::open(&output).unwrap()).unwrap();
    assert_eq!(archive.len() as u64, report.output_entries);
    let names: Vec<String> = (0..archive.len())
        .map(|index| archive.by_index(index).unwrap().name().to_string())
        .collect();
    assert!(names.contains(&"Payload/".to_string()));
    assert!(names.contains(&"Payload/LINE.app/".to_string()));
    assert!(!names.contains(&removable.to_string()));
}

#[test]
fn builds_zip64_candidate_with_more_than_u16_entries() {
    let temporary = TempDir::new().unwrap();
    let source_directory = make_fixture(temporary.path());
    let database = inspect_source(&source_directory).unwrap().database_path;
    let archive_path = temporary.path().join("LINE-large.imazingapp");
    let mut writer =
        zip::ZipWriter::new(fs::File::create(&archive_path).unwrap()).set_auto_large_file();
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    writer.start_file(".lock", options).unwrap();
    writer.write_all(b"lock").unwrap();
    writer
        .start_file("Payload/LINE.app/Info.plist", options)
        .unwrap();
    writer.write_all(b"plist").unwrap();
    writer.start_file(&database, options).unwrap();
    writer
        .write_all(&fs::read(source_directory.join(&database)).unwrap())
        .unwrap();
    for index in 0..65_536_u32 {
        writer
            .start_file(
                format!("Payload/LINE.app/Resources/{index:05}.bin"),
                options,
            )
            .unwrap();
        writer.write_all(&[(index & 0xff) as u8]).unwrap();
    }
    writer.finish().unwrap();

    let work = temporary.path().join("zip64-work");
    let mut catalog = Catalog::open(&work.join("catalog.sqlite")).unwrap();
    catalog
        .scan_source(&archive_path, SourceKind::ImazingArchive, |_| {})
        .unwrap();
    let output = temporary.path().join("LINE-large-candidate.imazingapp");
    let report =
        build_candidate(&archive_path, &output, &catalog, false, false, |_| Ok(())).unwrap();
    assert!(report.input_entries > u16::MAX as u64);
    assert!(report.output_entries > u16::MAX as u64);
    assert!(report.used_zip64);

    let archive = zip::ZipArchive::new(fs::File::open(&output).unwrap()).unwrap();
    assert_eq!(archive.len() as u64, report.output_entries);
}

#[test]
fn advanced_cleanup_rewrites_database_inside_archive_candidate() {
    let temporary = TempDir::new().unwrap();
    let source_directory = make_fixture(temporary.path());
    let database = inspect_source(&source_directory).unwrap().database_path;
    let attachment = "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test/Message Attachments/u1/12345678.jpg";
    let thumbnail = "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test/Message Thumbnails/u1/12345678.thumb";
    let archive_path = temporary.path().join("LINE-source.imazingapp");
    let archive_file = fs::File::create(&archive_path).unwrap();
    let mut writer = zip::ZipWriter::new(archive_file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let entries = vec![
        (".lock".to_string(), b"lock".to_vec()),
        ("Payload/LINE.app/Info.plist".to_string(), b"plist".to_vec()),
        (
            database.clone(),
            fs::read(source_directory.join(&database)).unwrap(),
        ),
        (
            attachment.to_string(),
            fs::read(source_directory.join(attachment)).unwrap(),
        ),
        (
            thumbnail.to_string(),
            fs::read(source_directory.join(thumbnail)).unwrap(),
        ),
    ];
    for (name, bytes) in entries {
        writer.start_file(name, options).unwrap();
        writer.write_all(&bytes).unwrap();
    }
    writer.finish().unwrap();
    let original_archive = fs::read(&archive_path).unwrap();

    let work = temporary.path().join("archive-advanced-work");
    let prepared = prepare_source(&archive_path, &work).unwrap();
    let line_database = LineDatabase::open(&prepared.database_path).unwrap();
    let mut catalog = Catalog::open(&work.join("catalog.sqlite")).unwrap();
    catalog
        .scan_source(&archive_path, SourceKind::ImazingArchive, |_| {})
        .unwrap();
    catalog
        .index_attachment_contexts(&line_database, None, None, |_| {})
        .unwrap();
    let chat = line_database.chat_for_cleanup(7).unwrap();
    catalog
        .set_chat_removal_planned(&chat, true, "selected")
        .unwrap();

    let output = temporary.path().join("LINE-archive-advanced.imazingapp");
    let report =
        build_candidate(&archive_path, &output, &catalog, true, false, |_| Ok(())).unwrap();
    assert_eq!(report.removed_chats, 1);
    assert_eq!(report.removed_messages, 4);
    assert_eq!(report.removed_entries, 2);
    assert_eq!(fs::read(&archive_path).unwrap(), original_archive);

    let mut archive = zip::ZipArchive::new(fs::File::open(output).unwrap()).unwrap();
    assert!(archive.by_name(attachment).is_err());
    assert!(archive.by_name(thumbnail).is_err());
    let extracted = temporary.path().join("archive-candidate-Line.sqlite");
    {
        let mut entry = archive.by_name(&database).unwrap();
        let mut output = fs::File::create(&extracted).unwrap();
        std::io::copy(&mut entry, &mut output).unwrap();
    }
    let connection = Connection::open(extracted).unwrap();
    let chats: i64 = connection
        .query_row("SELECT COUNT(*) FROM ZCHAT WHERE Z_PK = 7", [], |row| {
            row.get(0)
        })
        .unwrap();
    let messages: i64 = connection
        .query_row("SELECT COUNT(*) FROM ZMESSAGE WHERE ZCHAT = 7", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(chats, 0);
    assert_eq!(messages, 0);
    connection.close().unwrap();
}

#[test]
fn hashes_only_same_size_candidates_and_pages_duplicate_members() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let attachment_root = source.join(
        "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test",
    );
    let first = attachment_root.join("Message Attachments/c999/88888888.bin");
    let second = attachment_root.join("Message Thumbnails/c999/88888888.thumb");
    fs::create_dir_all(first.parent().unwrap()).unwrap();
    fs::create_dir_all(second.parent().unwrap()).unwrap();
    fs::write(&first, b"duplicate").unwrap();
    fs::write(&second, b"duplicate").unwrap();

    let catalog_path = temporary.path().join("work/catalog.sqlite");
    let mut catalog = Catalog::open(&catalog_path).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    let progress = catalog
        .hash_duplicate_candidates(&source, SourceKind::Directory, |_| Ok(()))
        .unwrap();
    assert_eq!(progress.candidate_files, 2);
    assert_eq!(progress.processed_files, 2);

    let groups = catalog.list_duplicate_groups(None, 10).unwrap();
    assert_eq!(groups.items.len(), 1);
    assert_eq!(groups.items[0].file_count, 2);
    assert_eq!(groups.items[0].reclaimable_bytes, 9);
    assert!(groups.items[0].has_original);
    assert!(groups.items[0].has_thumbnail);
    assert!(groups.items[0].preview_path.is_some());
    let members = catalog
        .list_duplicate_members(&groups.items[0].sha256, None, 1)
        .unwrap();
    assert_eq!(members.items.len(), 1);
    assert!(members.next_cursor.is_some());
    let rest = catalog
        .list_duplicate_members(&groups.items[0].sha256, members.next_cursor, 10)
        .unwrap();
    assert_eq!(rest.items.len(), 1);
    assert!(rest.next_cursor.is_none());

    let resumed = catalog
        .hash_duplicate_candidates(&source, SourceKind::Directory, |_| Ok(()))
        .unwrap();
    assert_eq!(resumed.candidate_files, 0);
    assert_eq!(resumed.processed_files, 0);
}

#[test]
fn links_only_duplicate_members_that_remain_after_removal_planning() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let private_store = "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test";
    let removed_path = format!("{private_store}/Message Attachments/c001/90000001.bin");
    let canonical_path = format!("{private_store}/Message Attachments/c002/90000002.bin");
    let linked_path = format!("{private_store}/Message Thumbnails/c003/90000003.thumb");
    for path in [&removed_path, &canonical_path, &linked_path] {
        fs::create_dir_all(source.join(path).parent().unwrap()).unwrap();
        fs::write(source.join(path), b"same duplicate attachment").unwrap();
    }

    let mut catalog = Catalog::open(&temporary.path().join("link-work/catalog.sqlite")).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    catalog
        .hash_duplicate_candidates(&source, SourceKind::Directory, |_| Ok(()))
        .unwrap();
    catalog.set_marked(&removed_path, true).unwrap();

    let output = temporary.path().join("LINE-linked.imazingapp");
    let report = build_candidate(&source, &output, &catalog, true, true, |_| Ok(())).unwrap();
    assert_eq!(report.linked_duplicate_entries, 1);
    assert_eq!(
        report.linked_duplicate_bytes,
        b"same duplicate attachment".len() as u64
    );

    let mut archive = zip::ZipArchive::new(fs::File::open(&output).unwrap()).unwrap();
    assert!(archive.by_name(&removed_path).is_err());
    assert!(!archive.by_name(&canonical_path).unwrap().is_symlink());
    let mut link = archive.by_name(&linked_path).unwrap();
    assert!(link.is_symlink());
    let mut target = String::new();
    link.read_to_string(&mut target).unwrap();
    assert_eq!(target, "../../Message Attachments/c002/90000002.bin");
    drop(link);

    catalog.set_marked(&canonical_path, true).unwrap();
    catalog.set_marked(&linked_path, true).unwrap();
    let all_removed_output = temporary
        .path()
        .join("LINE-all-duplicates-removed.imazingapp");
    let all_removed = build_candidate(&source, &all_removed_output, &catalog, true, true, |_| {
        Ok(())
    })
    .unwrap();
    assert_eq!(all_removed.linked_duplicate_entries, 0);
    let mut archive = zip::ZipArchive::new(fs::File::open(all_removed_output).unwrap()).unwrap();
    assert!(archive.by_name(&removed_path).is_err());
    assert!(archive.by_name(&canonical_path).is_err());
    assert!(archive.by_name(&linked_path).is_err());
}

#[test]
fn clears_partial_duplicate_hashes_when_hashing_is_interrupted() {
    let temporary = TempDir::new().unwrap();
    let source = make_fixture(temporary.path());
    let attachment_root = source.join(
        "Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_test/Message Attachments/c999",
    );
    fs::create_dir_all(&attachment_root).unwrap();
    for offset in 0..101_u32 {
        fs::write(
            attachment_root.join(format!("{:08}.bin", 10_000_000 + offset)),
            b"same bytes",
        )
        .unwrap();
    }

    let mut catalog = Catalog::open(&temporary.path().join("work/catalog.sqlite")).unwrap();
    catalog
        .scan_source(&source, SourceKind::Directory, |_| {})
        .unwrap();
    let result = catalog.hash_duplicate_candidates(&source, SourceKind::Directory, |progress| {
        if progress.processed_files >= 100 {
            Err(anyhow!("test interruption"))
        } else {
            Ok(())
        }
    });
    assert!(result.is_err());
    assert!(
        catalog
            .list_duplicate_groups(None, 10)
            .unwrap()
            .items
            .is_empty()
    );
}
