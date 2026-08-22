use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, MAIN_DB, OpenFlags, OptionalExtension, Row, params};

use crate::cancel::check_cancelled;
use crate::model::{
    AttachmentContext, Chat, ChatCursor, ChatPage, MAX_PAGE_SIZE, Message, MessageCursor,
    MessagePage, checked_page_size,
};
use crate::performance::system_performance_profile;

const SQLITE_QUERY_BATCH_SIZE: usize = 900;

pub struct LineDatabase {
    connection: Connection,
    chat_columns: HashSet<String>,
    message_columns: HashSet<String>,
    user_columns: HashSet<String>,
    group_columns: HashSet<String>,
}

pub struct LineSquareDatabase {
    connection: Connection,
    chat_columns: HashSet<String>,
    message_columns: HashSet<String>,
    square_columns: HashSet<String>,
    member_columns: HashSet<String>,
}

pub struct UnifiedGroupDatabase {
    connection: Connection,
    group_columns: HashSet<String>,
}

#[derive(Debug, Clone)]
pub struct SearchMessageRecord {
    pub source: &'static str,
    pub pk: i64,
    pub id: String,
    pub chat_pk: i64,
    pub timestamp: i64,
    pub sender_pk: Option<i64>,
    pub sender_name: String,
    pub sender_id: String,
    pub send_status: Option<i64>,
    pub content_type: Option<i64>,
    pub message_type: String,
    pub text: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

pub struct Fts5MessageIndex {
    path: PathBuf,
    connection: Connection,
}

impl Fts5MessageIndex {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(None, "temp_store", "FILE")?;
        connection.pragma_update(
            None,
            "cache_size",
            system_performance_profile().catalog_cache_kib,
        )?;
        connection.pragma_update(
            None,
            "threads",
            system_performance_profile().sqlite_workers as i64,
        )?;
        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS fts_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                text,
                source UNINDEXED,
                pk UNINDEXED,
                id UNINDEXED,
                chat_pk UNINDEXED,
                timestamp UNINDEXED,
                sender_pk UNINDEXED,
                sender_name UNINDEXED,
                sender_id UNINDEXED,
                send_status UNINDEXED,
                content_type UNINDEXED,
                message_type UNINDEXED,
                latitude UNINDEXED,
                longitude UNINDEXED,
                tokenize = 'unicode61'
            );
            ",
        )?;
        Ok(Self {
            path: path.to_path_buf(),
            connection,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn ensure_built<F>(
        &mut self,
        source_key: &str,
        line: &LineDatabase,
        square: Option<&LineSquareDatabase>,
        mut on_progress: F,
    ) -> Result<bool>
    where
        F: FnMut(u64),
    {
        let indexed_key: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM fts_meta WHERE key = 'source_key'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if indexed_key.as_deref() == Some(source_key) {
            return Ok(false);
        }
        let transaction = self.connection.transaction()?;
        transaction.execute("DELETE FROM messages_fts", [])?;
        let mut insert = transaction.prepare(
            "INSERT INTO messages_fts(
                 text, source, pk, id, chat_pk, timestamp, sender_pk, sender_name,
                 sender_id, send_status, content_type, message_type, latitude, longitude
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        )?;
        let mut processed = 0_u64;
        line.for_each_searchable_message(|record| {
            check_cancelled()?;
            insert_search_record(&mut insert, &record)?;
            processed += 1;
            on_progress(processed);
            Ok(())
        })?;
        if let Some(square) = square {
            square.for_each_searchable_message(|record| {
                check_cancelled()?;
                insert_search_record(&mut insert, &record)?;
                processed += 1;
                on_progress(processed);
                Ok(())
            })?;
        }
        drop(insert);
        transaction.execute(
            "INSERT INTO fts_meta(key, value) VALUES ('source_key', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [source_key],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn search(
        &self,
        query: &str,
        source: &str,
        chat_pk: Option<i64>,
        after_cursor: Option<MessageCursor>,
        before_cursor: Option<MessageCursor>,
        limit: u32,
        account_id: Option<&str>,
    ) -> Result<MessagePage> {
        if after_cursor.is_some() && before_cursor.is_some() {
            bail!("message search pagination cannot use both after and before cursors");
        }
        let limit = checked_page_size(limit)?;
        let pattern = validated_fts_pattern(query)?;
        let cursor = after_cursor.or(before_cursor).unwrap_or(MessageCursor {
            timestamp: i64::MIN,
            pk: 0,
        });
        let before = before_cursor.is_some();
        let timestamp_operator = if before { "<" } else { ">" };
        let order = if before { "DESC" } else { "ASC" };
        let sql = format!(
            "SELECT pk, id, chat_pk, timestamp, sender_pk, sender_name, sender_id,
                    send_status, content_type, message_type, text, latitude, longitude
             FROM messages_fts
             WHERE messages_fts MATCH ?1
               AND source = ?2
               AND (?3 IS NULL OR CAST(chat_pk AS INTEGER) = ?3)
               AND (CAST(timestamp AS INTEGER) {timestamp_operator} ?4
                    OR (CAST(timestamp AS INTEGER) = ?4 AND CAST(pk AS INTEGER) {timestamp_operator} ?5))
             ORDER BY CAST(timestamp AS INTEGER) {order}, CAST(pk AS INTEGER) {order}
             LIMIT ?6"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let mut rows = statement.query(params![
            pattern,
            source,
            chat_pk,
            cursor.timestamp,
            cursor.pk,
            limit as i64 + 1,
        ])?;
        let mut items = Vec::with_capacity(limit);
        while let Some(row) = rows.next()? {
            items.push(message_from_fts_row(row, source, account_id)?);
        }
        let has_extra = items.len() > limit;
        if has_extra {
            items.pop();
        }
        if before {
            items.reverse();
        }
        let next_cursor = if (before && !items.is_empty()) || has_extra {
            items.last().map(|message| MessageCursor {
                timestamp: message.timestamp,
                pk: message.pk,
            })
        } else {
            None
        };
        Ok(MessagePage {
            items,
            next_cursor,
            has_previous: if before {
                has_extra
            } else {
                after_cursor.is_some()
            },
        })
    }
}

fn insert_search_record(
    statement: &mut rusqlite::Statement<'_>,
    record: &SearchMessageRecord,
) -> rusqlite::Result<()> {
    statement.execute(params![
        record.text,
        record.source,
        record.pk,
        record.id,
        record.chat_pk,
        record.timestamp,
        record.sender_pk,
        record.sender_name,
        record.sender_id,
        record.send_status,
        record.content_type,
        record.message_type,
        record.latitude,
        record.longitude,
    ])?;
    Ok(())
}

#[derive(Debug, Clone)]
struct CompanionChatTitle {
    title: String,
    kind: String,
    source: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrphanMessage {
    pub pk: i64,
    pub id: String,
    pub chat_pk: Option<i64>,
}

impl LineDatabase {
    pub fn open(path: &Path) -> Result<Self> {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let connection = Connection::open_with_flags(path, flags)
            .with_context(|| format!("cannot open SQLite read-only: {}", path.display()))?;
        let performance = system_performance_profile();
        connection.pragma_update(None, "query_only", true)?;
        connection.pragma_update(None, "cache_size", performance.line_cache_kib)?;
        connection.pragma_update(None, "temp_store", "FILE")?;
        connection.pragma_update(None, "mmap_size", performance.line_mmap_bytes)?;
        connection.pragma_update(None, "threads", performance.sqlite_workers as i64)?;
        connection.pragma_update(None, "trusted_schema", false)?;

        let chat_columns = table_columns(&connection, "ZCHAT")?;
        let message_columns = table_columns(&connection, "ZMESSAGE")?;
        let user_columns = table_columns(&connection, "ZUSER")?;
        let group_columns = table_columns(&connection, "ZGROUP")?;
        if chat_columns.is_empty() || message_columns.is_empty() {
            bail!("SQLite does not contain both ZCHAT and ZMESSAGE");
        }
        Ok(Self {
            connection,
            chat_columns,
            message_columns,
            user_columns,
            group_columns,
        })
    }

    pub fn is_read_only(&self) -> Result<bool> {
        Ok(self.connection.is_readonly(MAIN_DB)?)
    }

    pub fn quick_check(&self) -> Result<String> {
        Ok(self
            .connection
            .query_row("PRAGMA quick_check", [], |row| row.get(0))?)
    }

    pub fn for_each_searchable_message<F>(&self, mut on_record: F) -> Result<()>
    where
        F: FnMut(SearchMessageRecord) -> Result<()>,
    {
        if !self.message_columns.contains("ZCHAT") || !self.message_columns.contains("ZTEXT") {
            return Ok(());
        }
        let message_id = text_expr("m", &self.message_columns, &["ZID"]);
        let timestamp = integer_expr("m", &self.message_columns, "ZTIMESTAMP", "0");
        let sender_pk = nullable_integer_expr("m", &self.message_columns, "ZSENDER");
        let send_status = nullable_integer_expr("m", &self.message_columns, "ZSENDSTATUS");
        let content_type = nullable_integer_expr("m", &self.message_columns, "ZCONTENTTYPE");
        let message_type = text_expr("m", &self.message_columns, &["ZMESSAGETYPE"]);
        let text = text_expr("m", &self.message_columns, &["ZTEXT"]);
        let latitude = nullable_real_expr("m", &self.message_columns, "ZLATITUDE");
        let longitude = nullable_real_expr("m", &self.message_columns, "ZLONGITUDE");
        let can_join_user =
            self.message_columns.contains("ZSENDER") && self.user_columns.contains("Z_PK");
        let sender_name = if can_join_user {
            coalesced_text_expr(
                "u",
                &self.user_columns,
                &["ZCUSTOMNAME", "ZADDRESSBOOKNAME", "ZNAME", "ZMID"],
            )
        } else {
            "''".to_string()
        };
        let sender_id = if can_join_user {
            text_expr("u", &self.user_columns, &["ZMID"])
        } else {
            "''".to_string()
        };
        let join = if can_join_user {
            " LEFT JOIN ZUSER u ON u.Z_PK = m.ZSENDER"
        } else {
            ""
        };
        let sql = format!(
            "SELECT CAST(m.Z_PK AS INTEGER), {message_id}, CAST(m.ZCHAT AS INTEGER),
                    {timestamp}, {sender_pk}, {sender_name}, {sender_id}, {send_status},
                    {content_type}, {message_type}, {text}, {latitude}, {longitude}
             FROM ZMESSAGE m{join}
             WHERE {text} <> '' ORDER BY m.Z_PK ASC"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            on_record(search_record_from_row(row, "line")?)?;
        }
        Ok(())
    }

    pub fn chat_for_cleanup(&self, chat_pk: i64) -> Result<Chat> {
        self.cleanup_chats(Some(chat_pk), false)?
            .into_iter()
            .next()
            .context("LINE chat does not exist")
    }

    pub fn advanced_cleanup_chats(&self) -> Result<Vec<Chat>> {
        self.cleanup_chats(None, true)
    }

    pub fn all_chats_for_cleanup(&self) -> Result<Vec<Chat>> {
        self.cleanup_chats(None, false)
    }

    fn cleanup_chats(&self, chat_pk: Option<i64>, filtered_only: bool) -> Result<Vec<Chat>> {
        if !self.message_columns.contains("ZCHAT") {
            bail!("ZMESSAGE does not contain ZCHAT");
        }
        let chat_id = text_expr("c", &self.chat_columns, &["ZMID", "ZID"]);
        let chat_type = integer_expr("c", &self.chat_columns, "ZTYPE", "0");
        let chat_name = text_expr("c", &self.chat_columns, &["ZNAME"]);
        let last_message = text_expr("c", &self.chat_columns, &["ZLASTMESSAGE"]);
        let last_updated = if self.chat_columns.contains("ZLASTUPDATED") {
            "CAST(COALESCE(c.ZLASTUPDATED, 0) AS INTEGER)".to_string()
        } else if self.message_columns.contains("ZTIMESTAMP") {
            "(SELECT CAST(COALESCE(MAX(mt.ZTIMESTAMP), 0) AS INTEGER) \
              FROM ZMESSAGE mt WHERE mt.ZCHAT = c.Z_PK)"
                .to_string()
        } else {
            "0".to_string()
        };
        let message_count =
            "(SELECT COUNT(*) FROM ZMESSAGE mc WHERE mc.ZCHAT = c.Z_PK)".to_string();
        let human_predicate = human_message_predicate("hm", &self.message_columns);
        let human_message_count = format!(
            "(SELECT COUNT(*) FROM ZMESSAGE hm \
              WHERE hm.ZCHAT = c.Z_PK AND {human_predicate})"
        );
        let sql = format!(
            "SELECT CAST(c.Z_PK AS INTEGER), {chat_id}, {chat_type}, {chat_name}, \
                    {message_count}, {human_message_count}, {last_updated}, {last_message} \
             FROM ZCHAT c \
             WHERE (?1 IS NULL OR c.Z_PK = ?1) \
               AND (?2 = 0 OR {message_count} = 0 OR {human_message_count} = 0) \
             ORDER BY c.Z_PK ASC"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(params![chat_pk, i64::from(filtered_only)], |row| {
            let id: String = row.get(1)?;
            let name: String = row.get(3)?;
            Ok(Chat {
                pk: row.get(0)?,
                source: "line".to_string(),
                id: id.clone(),
                chat_type: row.get(2)?,
                kind: chat_kind(row.get(2)?).to_string(),
                title: if !name.is_empty() {
                    name
                } else if !id.is_empty() {
                    id
                } else {
                    "未命名聊天室".to_string()
                },
                title_source: "chat".to_string(),
                message_count: row.get(4)?,
                human_message_count: row.get(5)?,
                last_updated: row.get(6)?,
                last_message: row.get(7)?,
                planned_for_removal: false,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_chats(&self, cursor: Option<ChatCursor>, limit: u32) -> Result<ChatPage> {
        self.list_chats_with_boundaries(cursor, None, limit)
    }

    /// Builds a disposable chat index with one bounded set of source-table scans.
    ///
    /// This deliberately does not add an index to the LINE database. Some LINE schemas do not
    /// index `ZMESSAGE.ZCHAT`, which makes the correlated count queries used by interactive
    /// fallback pagination scan the message table once per chat. The desktop persists these
    /// derived rows in its private `catalog.sqlite` instead.
    pub fn chats_for_index(&self) -> Result<Vec<Chat>> {
        if !self.message_columns.contains("ZCHAT") {
            return Ok(Vec::new());
        }
        let chat_id = text_expr("c", &self.chat_columns, &["ZMID", "ZID"]);
        let chat_type = integer_expr("c", &self.chat_columns, "ZTYPE", "0");
        let chat_name = text_expr("c", &self.chat_columns, &["ZNAME"]);
        let last_message = text_expr("c", &self.chat_columns, &["ZLASTMESSAGE"]);
        let timestamp = integer_expr("m", &self.message_columns, "ZTIMESTAMP", "0");
        let last_updated = if self.chat_columns.contains("ZLASTUPDATED") {
            "CAST(COALESCE(c.ZLASTUPDATED, 0) AS INTEGER)".to_string()
        } else {
            "CAST(COALESCE(stats.last_updated, 0) AS INTEGER)".to_string()
        };
        let (message_count, stats_join) = if self.chat_columns.contains("ZMESSAGECOUNT") {
            (
                "CAST(COALESCE(c.ZMESSAGECOUNT, 0) AS INTEGER)".to_string(),
                "LEFT JOIN",
            )
        } else {
            ("stats.message_count".to_string(), "JOIN")
        };
        let human_predicate = human_message_predicate("m", &self.message_columns);
        let rename_text = if self.message_columns.contains("ZCONTENTTYPE")
            && self.message_columns.contains("ZTEXT")
        {
            "COALESCE(rename.text, '')"
        } else {
            "''"
        };
        let rename_cte = if self.message_columns.contains("ZCONTENTTYPE")
            && self.message_columns.contains("ZTEXT")
        {
            let rename_timestamp = integer_expr("r", &self.message_columns, "ZTIMESTAMP", "0");
            format!(
                ",
                rename_messages AS (
                    SELECT chat_pk, text
                    FROM (
                        SELECT CAST(r.ZCHAT AS INTEGER) AS chat_pk,
                               CAST(r.ZTEXT AS TEXT) AS text,
                               ROW_NUMBER() OVER (
                                   PARTITION BY r.ZCHAT
                                   ORDER BY {rename_timestamp} DESC, r.Z_PK DESC
                               ) AS position
                        FROM ZMESSAGE r
                        WHERE CAST(r.ZCONTENTTYPE AS INTEGER) = 18
                          AND r.ZTEXT IS NOT NULL
                          AND (
                              r.ZTEXT LIKE '%群組名稱%'
                              OR LOWER(CAST(r.ZTEXT AS TEXT)) LIKE '%group%name%'
                          )
                    )
                    WHERE position = 1
                )"
            )
        } else {
            String::new()
        };
        let rename_join = if rename_cte.is_empty() {
            ""
        } else {
            " LEFT JOIN rename_messages rename ON rename.chat_pk = c.Z_PK"
        };
        let can_join_user =
            self.user_columns.contains("ZMID") && self.chat_columns.contains("ZMID");
        let can_join_group =
            self.group_columns.contains("ZID") && self.chat_columns.contains("ZMID");
        let user_name = if can_join_user {
            coalesced_text_expr(
                "u",
                &self.user_columns,
                &["ZCUSTOMNAME", "ZADDRESSBOOKNAME", "ZNAME", "ZMID"],
            )
        } else {
            "''".to_string()
        };
        let group_name = if can_join_group {
            coalesced_text_expr("g", &self.group_columns, &["ZNAME", "ZID"])
        } else {
            "''".to_string()
        };
        let joins = format!(
            "{}{}{}",
            if can_join_user {
                " LEFT JOIN ZUSER u ON CAST(u.ZMID AS TEXT) = CAST(c.ZMID AS TEXT)"
            } else {
                ""
            },
            if can_join_group {
                " LEFT JOIN ZGROUP g ON CAST(g.ZID AS TEXT) = CAST(c.ZMID AS TEXT)"
            } else {
                ""
            },
            rename_join
        );
        let sql = format!(
            "
            WITH message_stats AS (
                SELECT CAST(m.ZCHAT AS INTEGER) AS chat_pk,
                       COUNT(*) AS message_count,
                       SUM(CASE WHEN {human_predicate} THEN 1 ELSE 0 END)
                           AS human_message_count,
                       MAX({timestamp}) AS last_updated
                FROM ZMESSAGE m
                GROUP BY m.ZCHAT
            )
            {rename_cte}
            SELECT CAST(c.Z_PK AS INTEGER), {chat_id}, {chat_type}, {chat_name},
                   {user_name}, {group_name}, {message_count},
                   CAST(COALESCE(stats.human_message_count, 0) AS INTEGER),
                   {last_updated}, {last_message}, {rename_text}
            FROM ZCHAT c
            {stats_join} message_stats stats ON stats.chat_pk = c.Z_PK
            {joins}
            WHERE {message_count} > 0
            ORDER BY {last_updated} DESC, c.Z_PK ASC
            "
        );
        let mut statement = self.connection.prepare(&sql)?;
        let mut rows = statement.query([])?;
        let mut chats = Vec::new();
        while let Some(row) = rows.next()? {
            let id: String = row.get(1)?;
            let chat_type: i64 = row.get(2)?;
            let chat_name: String = row.get(3)?;
            let user_name: String = row.get(4)?;
            let group_name: String = row.get(5)?;
            let rename_text: String = row.get(10)?;
            let rename_name = extract_group_name_from_system_text(&rename_text);
            let (title, title_source) = if chat_type == 0 && !user_name.is_empty() {
                (user_name, "user".to_string())
            } else if chat_type != 0 && !group_name.is_empty() {
                (group_name, "group".to_string())
            } else if chat_type != 0 && !rename_name.is_empty() {
                (rename_name, "rename".to_string())
            } else if !chat_name.is_empty() {
                (chat_name, "chat".to_string())
            } else if !id.is_empty() {
                (id.clone(), "id".to_string())
            } else {
                ("未命名聊天室".to_string(), "unresolved".to_string())
            };
            chats.push(Chat {
                pk: row.get(0)?,
                source: "line".to_string(),
                id,
                chat_type,
                kind: chat_kind(chat_type).to_string(),
                title,
                title_source,
                message_count: row.get(6)?,
                human_message_count: row.get(7)?,
                last_updated: row.get(8)?,
                last_message: row.get(9)?,
                planned_for_removal: false,
            });
        }
        Ok(chats)
    }

    pub fn list_chats_before(&self, cursor: ChatCursor, limit: u32) -> Result<ChatPage> {
        self.list_chats_with_boundaries(None, Some(cursor), limit)
    }

    fn list_chats_with_boundaries(
        &self,
        after_cursor: Option<ChatCursor>,
        before_cursor: Option<ChatCursor>,
        limit: u32,
    ) -> Result<ChatPage> {
        if after_cursor.is_some() && before_cursor.is_some() {
            bail!("chat pagination cannot use both after and before cursors");
        }
        let limit = checked_page_size(limit)?;
        let chat_id = text_expr("c", &self.chat_columns, &["ZMID", "ZID"]);
        let chat_type = integer_expr("c", &self.chat_columns, "ZTYPE", "0");
        let chat_name = text_expr("c", &self.chat_columns, &["ZNAME"]);
        let last_message = text_expr("c", &self.chat_columns, &["ZLASTMESSAGE"]);
        let last_updated = if self.chat_columns.contains("ZLASTUPDATED") {
            "CAST(COALESCE(c.ZLASTUPDATED, 0) AS INTEGER)".to_string()
        } else if self.message_columns.contains("ZTIMESTAMP")
            && self.message_columns.contains("ZCHAT")
        {
            "(SELECT CAST(COALESCE(MAX(mt.ZTIMESTAMP), 0) AS INTEGER) FROM ZMESSAGE mt WHERE mt.ZCHAT = c.Z_PK)".to_string()
        } else {
            "0".to_string()
        };
        let message_count = if self.chat_columns.contains("ZMESSAGECOUNT") {
            "CAST(COALESCE(c.ZMESSAGECOUNT, 0) AS INTEGER)".to_string()
        } else if self.message_columns.contains("ZCHAT") {
            "(SELECT COUNT(*) FROM ZMESSAGE mc WHERE mc.ZCHAT = c.Z_PK)".to_string()
        } else {
            "0".to_string()
        };
        let human_message_count = if self.message_columns.contains("ZCHAT") {
            let predicate = human_message_predicate("hm", &self.message_columns);
            format!("(SELECT COUNT(*) FROM ZMESSAGE hm WHERE hm.ZCHAT = c.Z_PK AND {predicate})")
        } else {
            "0".to_string()
        };
        let rename_text = group_rename_text_expr("c.Z_PK", &self.message_columns, "mr");

        let can_join_user = self.user_columns.contains("ZMID")
            && self.chat_columns.iter().any(|name| name == "ZMID");
        let can_join_group = self.group_columns.contains("ZID")
            && self.chat_columns.iter().any(|name| name == "ZMID");
        let user_name = if can_join_user {
            coalesced_text_expr(
                "u",
                &self.user_columns,
                &["ZCUSTOMNAME", "ZADDRESSBOOKNAME", "ZNAME", "ZMID"],
            )
        } else {
            "''".to_string()
        };
        let group_name = if can_join_group {
            coalesced_text_expr("g", &self.group_columns, &["ZNAME", "ZID"])
        } else {
            "''".to_string()
        };
        let joins = format!(
            "{}{}",
            if can_join_user {
                " LEFT JOIN ZUSER u ON CAST(u.ZMID AS TEXT) = CAST(c.ZMID AS TEXT)"
            } else {
                ""
            },
            if can_join_group {
                " LEFT JOIN ZGROUP g ON CAST(g.ZID AS TEXT) = CAST(c.ZMID AS TEXT)"
            } else {
                ""
            }
        );
        let boundary = after_cursor.as_ref().or(before_cursor.as_ref());
        let cursor_filter = if let Some(cursor) = boundary {
            let tie_filter = if before_cursor.is_some() {
                source_cursor_before_filter("line", &cursor.source, "c.Z_PK", "?2")
            } else {
                source_cursor_tie_filter("line", &cursor.source, "c.Z_PK", "?2")
            };
            format!(
                " WHERE {message_count} > 0 \
                 AND ({last_updated} {} ?1 OR ({last_updated} = ?1 AND {tie_filter}))",
                if before_cursor.is_some() { ">" } else { "<" }
            )
        } else {
            format!(" WHERE {message_count} > 0")
        };
        let order_by = if before_cursor.is_some() {
            format!(" ORDER BY {last_updated} ASC, c.Z_PK DESC")
        } else {
            format!(" ORDER BY {last_updated} DESC, c.Z_PK ASC")
        };
        let sql = format!(
            "SELECT CAST(c.Z_PK AS INTEGER), {chat_id}, {chat_type}, {chat_name}, \
             {user_name}, {group_name}, {message_count}, {human_message_count}, \
             {last_updated}, {last_message}, \
             {rename_text} \
             FROM ZCHAT c{joins}{cursor_filter} \
             {order_by} LIMIT ?3"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let cursor = boundary.cloned().unwrap_or(ChatCursor {
            last_updated: i64::MAX,
            source: "line".to_string(),
            pk: 0,
        });
        let mut rows =
            statement.query(params![cursor.last_updated, cursor.pk, limit as i64 + 1])?;
        let mut items = Vec::with_capacity(limit);
        while let Some(row) = rows.next()? {
            let id: String = row.get(1)?;
            let chat_type: i64 = row.get(2)?;
            let chat_name: String = row.get(3)?;
            let user_name: String = row.get(4)?;
            let group_name: String = row.get(5)?;
            let rename_text: String = row.get(10)?;
            let rename_name = extract_group_name_from_system_text(&rename_text);
            let (title, title_source) = if chat_type == 0 && !user_name.is_empty() {
                (user_name, "user".to_string())
            } else if chat_type != 0 && !group_name.is_empty() {
                (group_name, "group".to_string())
            } else if chat_type != 0 && !rename_name.is_empty() {
                (rename_name, "rename".to_string())
            } else if !chat_name.is_empty() {
                (chat_name, "chat".to_string())
            } else if !id.is_empty() {
                (id.clone(), "id".to_string())
            } else {
                ("未命名聊天室".to_string(), "unresolved".to_string())
            };
            items.push(Chat {
                pk: row.get(0)?,
                source: "line".to_string(),
                id,
                chat_type,
                kind: chat_kind(chat_type).to_string(),
                title,
                title_source,
                message_count: row.get(6)?,
                human_message_count: row.get(7)?,
                last_updated: row.get(8)?,
                last_message: row.get(9)?,
                planned_for_removal: false,
            });
        }
        let has_extra = items.len() > limit;
        if has_extra {
            items.pop();
        }
        if before_cursor.is_some() {
            items.reverse();
        }
        let next_cursor = if (before_cursor.is_some() && !items.is_empty()) || has_extra {
            items.last().map(|chat| ChatCursor {
                last_updated: chat.last_updated,
                source: chat.source.clone(),
                pk: chat.pk,
            })
        } else {
            None
        };
        let has_previous = if before_cursor.is_some() {
            has_extra
        } else {
            after_cursor.is_some()
        };
        Ok(ChatPage {
            items,
            next_cursor,
            has_previous,
        })
    }

    pub fn enrich_chat_titles(
        &self,
        chats: &mut [Chat],
        unified_groups: Option<&UnifiedGroupDatabase>,
        square_database: Option<&LineSquareDatabase>,
    ) -> Result<()> {
        let ids = chats
            .iter()
            .filter(|chat| chat.chat_type != 0 && !chat.id.is_empty())
            .map(|chat| chat.id.clone())
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(());
        }
        let square_titles = square_database
            .map(|database| database.chat_titles(&ids))
            .transpose()?
            .unwrap_or_default();
        let unified_titles = unified_groups
            .map(|database| database.chat_titles(&ids))
            .transpose()?
            .unwrap_or_default();
        for chat in chats {
            if chat.chat_type == 0 || chat.id.is_empty() {
                continue;
            }
            let key = lookup_id(&chat.id);
            if let Some(title) = square_titles.get(&key).or_else(|| unified_titles.get(&key)) {
                chat.title.clone_from(&title.title);
                chat.title_source = title.source.to_string();
                if title.kind == "community" {
                    chat.kind = title.kind.clone();
                }
            }
        }
        Ok(())
    }

    pub fn enrich_attachment_context_titles(
        &self,
        contexts: &mut HashMap<String, Vec<AttachmentContext>>,
        unified_groups: Option<&UnifiedGroupDatabase>,
        square_database: Option<&LineSquareDatabase>,
    ) -> Result<()> {
        let ids = contexts
            .values()
            .flatten()
            .filter(|context| context.chat_kind != "direct" && !context.chat_id.is_empty())
            .map(|context| context.chat_id.clone())
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(());
        }
        let square_titles = square_database
            .map(|database| database.chat_titles(&ids))
            .transpose()?
            .unwrap_or_default();
        let unified_titles = unified_groups
            .map(|database| database.chat_titles(&ids))
            .transpose()?
            .unwrap_or_default();
        for context in contexts.values_mut().flatten() {
            if context.chat_kind == "direct" || context.chat_id.is_empty() {
                continue;
            }
            let key = lookup_id(&context.chat_id);
            if let Some(title) = square_titles.get(&key).or_else(|| unified_titles.get(&key)) {
                context.chat_title.clone_from(&title.title);
                if title.kind == "community" {
                    context.chat_kind = title.kind.clone();
                }
            }
        }
        Ok(())
    }

    pub fn list_messages(
        &self,
        chat_pk: i64,
        cursor: Option<MessageCursor>,
        limit: u32,
    ) -> Result<MessagePage> {
        self.list_messages_for_account(chat_pk, cursor, limit, None)
    }

    pub fn list_messages_before(
        &self,
        chat_pk: i64,
        cursor: MessageCursor,
        limit: u32,
    ) -> Result<MessagePage> {
        self.list_messages_for_account_before(chat_pk, cursor, limit, None)
    }

    pub fn list_messages_for_account(
        &self,
        chat_pk: i64,
        cursor: Option<MessageCursor>,
        limit: u32,
        account_id: Option<&str>,
    ) -> Result<MessagePage> {
        self.list_messages_for_account_with_boundaries(chat_pk, cursor, None, limit, account_id)
    }

    pub fn list_messages_for_account_before(
        &self,
        chat_pk: i64,
        cursor: MessageCursor,
        limit: u32,
        account_id: Option<&str>,
    ) -> Result<MessagePage> {
        self.list_messages_for_account_with_boundaries(
            chat_pk,
            None,
            Some(cursor),
            limit,
            account_id,
        )
    }

    fn list_messages_for_account_with_boundaries(
        &self,
        chat_pk: i64,
        after_cursor: Option<MessageCursor>,
        before_cursor: Option<MessageCursor>,
        limit: u32,
        account_id: Option<&str>,
    ) -> Result<MessagePage> {
        if after_cursor.is_some() && before_cursor.is_some() {
            bail!("message pagination cannot use both after and before cursors");
        }
        let limit = checked_page_size(limit)?;
        if !self.message_columns.contains("ZCHAT") {
            bail!("ZMESSAGE does not contain ZCHAT");
        }
        let message_id = text_expr("m", &self.message_columns, &["ZID"]);
        let timestamp = integer_expr("m", &self.message_columns, "ZTIMESTAMP", "0");
        let sender_pk = nullable_integer_expr("m", &self.message_columns, "ZSENDER");
        let send_status = nullable_integer_expr("m", &self.message_columns, "ZSENDSTATUS");
        let content_type = nullable_integer_expr("m", &self.message_columns, "ZCONTENTTYPE");
        let message_type = text_expr("m", &self.message_columns, &["ZMESSAGETYPE"]);
        let text = text_expr("m", &self.message_columns, &["ZTEXT"]);
        let latitude = nullable_real_expr("m", &self.message_columns, "ZLATITUDE");
        let longitude = nullable_real_expr("m", &self.message_columns, "ZLONGITUDE");
        let can_join_user =
            self.message_columns.contains("ZSENDER") && self.user_columns.contains("Z_PK");
        let sender_name = if can_join_user {
            coalesced_text_expr(
                "u",
                &self.user_columns,
                &["ZCUSTOMNAME", "ZADDRESSBOOKNAME", "ZNAME", "ZMID"],
            )
        } else {
            "''".to_string()
        };
        let sender_id = if can_join_user {
            text_expr("u", &self.user_columns, &["ZMID"])
        } else {
            "''".to_string()
        };
        let join = if can_join_user {
            " LEFT JOIN ZUSER u ON u.Z_PK = m.ZSENDER"
        } else {
            ""
        };
        let sql = format!(
            "SELECT CAST(m.Z_PK AS INTEGER), {message_id}, CAST(m.ZCHAT AS INTEGER), \
             {timestamp}, {sender_pk}, {sender_name}, {sender_id}, {send_status}, {content_type}, \
             {message_type}, {text}, {latitude}, {longitude} \
             FROM ZMESSAGE m{join} \
             WHERE m.ZCHAT = ?1 AND ({timestamp} {} ?2 OR ({timestamp} = ?2 AND m.Z_PK {} ?3)) \
             ORDER BY {timestamp} {}, m.Z_PK {} LIMIT ?4",
            if before_cursor.is_some() { "<" } else { ">" },
            if before_cursor.is_some() { "<" } else { ">" },
            if before_cursor.is_some() {
                "DESC"
            } else {
                "ASC"
            },
            if before_cursor.is_some() {
                "DESC"
            } else {
                "ASC"
            }
        );
        let cursor = after_cursor.or(before_cursor).unwrap_or(MessageCursor {
            timestamp: i64::MIN,
            pk: 0,
        });
        let mut statement = self.connection.prepare(&sql)?;
        let mut rows = statement.query(params![
            chat_pk,
            cursor.timestamp,
            cursor.pk,
            limit as i64 + 1
        ])?;
        let mut items = Vec::with_capacity(limit);
        while let Some(row) = rows.next()? {
            items.push(message_from_row(row, "line", account_id)?);
        }
        let has_extra = items.len() > limit;
        if has_extra {
            items.pop();
        }
        if before_cursor.is_some() {
            items.reverse();
        }
        let next_cursor = if (before_cursor.is_some() && !items.is_empty()) || has_extra {
            items.last().map(|message| MessageCursor {
                timestamp: message.timestamp,
                pk: message.pk,
            })
        } else {
            None
        };
        let has_previous = if before_cursor.is_some() {
            has_extra
        } else {
            after_cursor.is_some()
        };
        Ok(MessagePage {
            items,
            next_cursor,
            has_previous,
        })
    }

    pub fn search_messages(
        &self,
        query: &str,
        chat_pk: Option<i64>,
        cursor: Option<MessageCursor>,
        limit: u32,
    ) -> Result<MessagePage> {
        self.search_messages_for_account(query, chat_pk, cursor, limit, None)
    }

    pub fn search_messages_before(
        &self,
        query: &str,
        chat_pk: Option<i64>,
        cursor: MessageCursor,
        limit: u32,
    ) -> Result<MessagePage> {
        self.search_messages_for_account_before(query, chat_pk, cursor, limit, None)
    }

    pub fn search_messages_for_account(
        &self,
        query: &str,
        chat_pk: Option<i64>,
        cursor: Option<MessageCursor>,
        limit: u32,
        account_id: Option<&str>,
    ) -> Result<MessagePage> {
        self.search_messages_for_account_with_boundaries(
            query, chat_pk, cursor, None, limit, account_id,
        )
    }

    pub fn search_messages_for_account_before(
        &self,
        query: &str,
        chat_pk: Option<i64>,
        cursor: MessageCursor,
        limit: u32,
        account_id: Option<&str>,
    ) -> Result<MessagePage> {
        self.search_messages_for_account_with_boundaries(
            query,
            chat_pk,
            None,
            Some(cursor),
            limit,
            account_id,
        )
    }

    fn search_messages_for_account_with_boundaries(
        &self,
        query: &str,
        chat_pk: Option<i64>,
        after_cursor: Option<MessageCursor>,
        before_cursor: Option<MessageCursor>,
        limit: u32,
        account_id: Option<&str>,
    ) -> Result<MessagePage> {
        if after_cursor.is_some() && before_cursor.is_some() {
            bail!("message search pagination cannot use both after and before cursors");
        }
        let query = validated_search_pattern(query)?;
        let limit = checked_page_size(limit)?;
        if !self.message_columns.contains("ZCHAT") {
            bail!("ZMESSAGE does not contain ZCHAT");
        }
        if !self.message_columns.contains("ZTEXT") {
            bail!("ZMESSAGE does not contain searchable text");
        }
        let message_id = text_expr("m", &self.message_columns, &["ZID"]);
        let timestamp = integer_expr("m", &self.message_columns, "ZTIMESTAMP", "0");
        let sender_pk = nullable_integer_expr("m", &self.message_columns, "ZSENDER");
        let send_status = nullable_integer_expr("m", &self.message_columns, "ZSENDSTATUS");
        let content_type = nullable_integer_expr("m", &self.message_columns, "ZCONTENTTYPE");
        let message_type = text_expr("m", &self.message_columns, &["ZMESSAGETYPE"]);
        let text = text_expr("m", &self.message_columns, &["ZTEXT"]);
        let latitude = nullable_real_expr("m", &self.message_columns, "ZLATITUDE");
        let longitude = nullable_real_expr("m", &self.message_columns, "ZLONGITUDE");
        let can_join_user =
            self.message_columns.contains("ZSENDER") && self.user_columns.contains("Z_PK");
        let sender_name = if can_join_user {
            coalesced_text_expr(
                "u",
                &self.user_columns,
                &["ZCUSTOMNAME", "ZADDRESSBOOKNAME", "ZNAME", "ZMID"],
            )
        } else {
            "''".to_string()
        };
        let sender_id = if can_join_user {
            text_expr("u", &self.user_columns, &["ZMID"])
        } else {
            "''".to_string()
        };
        let join = if can_join_user {
            " LEFT JOIN ZUSER u ON u.Z_PK = m.ZSENDER"
        } else {
            ""
        };
        let sql = format!(
            "SELECT CAST(m.Z_PK AS INTEGER), {message_id}, CAST(m.ZCHAT AS INTEGER), \
             {timestamp}, {sender_pk}, {sender_name}, {sender_id}, {send_status}, {content_type}, \
             {message_type}, {text}, {latitude}, {longitude} \
             FROM ZMESSAGE m{join} \
             WHERE {text} LIKE ?1 ESCAPE '\\' \
               AND (?2 IS NULL OR m.ZCHAT = ?2) \
               AND ({timestamp} {} ?3 OR ({timestamp} = ?3 AND m.Z_PK {} ?4)) \
             ORDER BY {timestamp} {}, m.Z_PK {} LIMIT ?5",
            if before_cursor.is_some() { "<" } else { ">" },
            if before_cursor.is_some() { "<" } else { ">" },
            if before_cursor.is_some() {
                "DESC"
            } else {
                "ASC"
            },
            if before_cursor.is_some() {
                "DESC"
            } else {
                "ASC"
            }
        );
        let cursor = after_cursor.or(before_cursor).unwrap_or(MessageCursor {
            timestamp: i64::MIN,
            pk: 0,
        });
        let mut statement = self.connection.prepare(&sql)?;
        let mut rows = statement.query(params![
            query,
            chat_pk,
            cursor.timestamp,
            cursor.pk,
            limit as i64 + 1
        ])?;
        let mut items = Vec::with_capacity(limit);
        while let Some(row) = rows.next()? {
            items.push(message_from_row(row, "line", account_id)?);
        }
        let has_extra = items.len() > limit;
        if has_extra {
            items.pop();
        }
        if before_cursor.is_some() {
            items.reverse();
        }
        let next_cursor = if (before_cursor.is_some() && !items.is_empty()) || has_extra {
            items.last().map(|message| MessageCursor {
                timestamp: message.timestamp,
                pk: message.pk,
            })
        } else {
            None
        };
        let has_previous = if before_cursor.is_some() {
            has_extra
        } else {
            after_cursor.is_some()
        };
        Ok(MessagePage {
            items,
            next_cursor,
            has_previous,
        })
    }

    pub fn attachment_contexts(
        &self,
        message_ids: &[String],
    ) -> Result<HashMap<String, Vec<AttachmentContext>>> {
        if message_ids.len() > MAX_PAGE_SIZE as usize {
            bail!("attachment context batch cannot exceed {MAX_PAGE_SIZE} message IDs");
        }
        if message_ids.is_empty()
            || !self.message_columns.contains("ZID")
            || !self.message_columns.contains("ZCHAT")
        {
            return Ok(HashMap::new());
        }
        let timestamp = integer_expr("m", &self.message_columns, "ZTIMESTAMP", "0");
        let sender_pk = nullable_integer_expr("m", &self.message_columns, "ZSENDER");
        let content_type = nullable_integer_expr("m", &self.message_columns, "ZCONTENTTYPE");
        let text = text_expr("m", &self.message_columns, &["ZTEXT"]);
        let chat_type = integer_expr("c", &self.chat_columns, "ZTYPE", "0");
        let chat_id = text_expr("c", &self.chat_columns, &["ZMID", "ZID"]);
        let chat_name = text_expr("c", &self.chat_columns, &["ZNAME"]);
        let can_join_sender =
            self.message_columns.contains("ZSENDER") && self.user_columns.contains("Z_PK");
        let sender_name = if can_join_sender {
            coalesced_text_expr(
                "su",
                &self.user_columns,
                &["ZCUSTOMNAME", "ZADDRESSBOOKNAME", "ZNAME", "ZMID"],
            )
        } else {
            "''".to_string()
        };
        let can_join_chat_user =
            self.chat_columns.contains("ZMID") && self.user_columns.contains("ZMID");
        let chat_user_name = if can_join_chat_user {
            coalesced_text_expr(
                "cu",
                &self.user_columns,
                &["ZCUSTOMNAME", "ZADDRESSBOOKNAME", "ZNAME", "ZMID"],
            )
        } else {
            "''".to_string()
        };
        let can_join_group =
            self.chat_columns.contains("ZMID") && self.group_columns.contains("ZID");
        let group_name = if can_join_group {
            coalesced_text_expr("g", &self.group_columns, &["ZNAME", "ZID"])
        } else {
            "''".to_string()
        };
        let rename_text = group_rename_text_expr("m.ZCHAT", &self.message_columns, "rm");
        let joins = format!(
            " LEFT JOIN ZCHAT c ON c.Z_PK = m.ZCHAT{}{}{}",
            if can_join_sender {
                " LEFT JOIN ZUSER su ON su.Z_PK = m.ZSENDER"
            } else {
                ""
            },
            if can_join_chat_user {
                " LEFT JOIN ZUSER cu ON CAST(cu.ZMID AS TEXT) = CAST(c.ZMID AS TEXT)"
            } else {
                ""
            },
            if can_join_group {
                " LEFT JOIN ZGROUP g ON CAST(g.ZID AS TEXT) = CAST(c.ZMID AS TEXT)"
            } else {
                ""
            }
        );
        let mut contexts: HashMap<String, Vec<AttachmentContext>> = HashMap::new();
        for chunk in message_ids.chunks(SQLITE_QUERY_BATCH_SIZE) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT CAST(m.Z_PK AS INTEGER), CAST(m.ZID AS TEXT), \
                 CAST(m.ZCHAT AS INTEGER), {timestamp}, {sender_pk}, {sender_name}, \
                 {content_type}, {text}, {chat_type}, {chat_id}, {chat_name}, \
                 {chat_user_name}, {group_name}, {rename_text} \
                 FROM ZMESSAGE m{joins} \
                 WHERE m.ZID IN ({placeholders}) \
                 ORDER BY m.Z_PK ASC"
            );
            let mut statement = self.connection.prepare(&sql)?;
            let mut rows =
                statement.query(rusqlite::params_from_iter(chunk.iter().map(String::as_str)))?;
            while let Some(row) = rows.next()? {
                let message_id: String = row.get(1)?;
                let chat_type: i64 = row.get(8)?;
                let chat_id: String = row.get(9)?;
                let chat_name: String = row.get(10)?;
                let chat_user_name: String = row.get(11)?;
                let group_name: String = row.get(12)?;
                let rename_text: String = row.get(13)?;
                let rename_name = extract_group_name_from_system_text(&rename_text);
                let chat_title = if chat_type == 0 && !chat_user_name.is_empty() {
                    chat_user_name
                } else if chat_type != 0 && !group_name.is_empty() {
                    group_name
                } else if chat_type != 0 && !rename_name.is_empty() {
                    rename_name
                } else if !chat_name.is_empty() {
                    chat_name
                } else if !chat_id.is_empty() {
                    chat_id.clone()
                } else {
                    "未命名聊天室".to_string()
                };
                contexts
                    .entry(message_id)
                    .or_default()
                    .push(AttachmentContext {
                        source: "line".to_string(),
                        message_pk: row.get(0)?,
                        chat_pk: row.get(2)?,
                        chat_id,
                        chat_title,
                        chat_kind: chat_kind(chat_type).to_string(),
                        timestamp: row.get(3)?,
                        sender_pk: row.get(4)?,
                        sender_name: row.get(5)?,
                        content_type: row.get(6)?,
                        text: row.get(7)?,
                    });
            }
        }
        Ok(contexts)
    }

    pub fn explain_message_page(&self, chat_pk: i64) -> Result<Vec<String>> {
        let timestamp = integer_expr("m", &self.message_columns, "ZTIMESTAMP", "0");
        let sql = format!(
            "EXPLAIN QUERY PLAN SELECT m.Z_PK FROM ZMESSAGE m \
             WHERE m.ZCHAT = ?1 AND ({timestamp} > ?2 OR ({timestamp} = ?2 AND m.Z_PK > ?3)) \
             ORDER BY {timestamp} ASC, m.Z_PK ASC LIMIT 180"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(params![chat_pk, 0_i64, 0_i64], |row| row.get(3))?;
        Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
    }

    pub fn table_row_count(&self, table: &str) -> Result<Option<i64>> {
        if !matches!(table, "ZCHAT" | "ZMESSAGE" | "ZUSER" | "ZGROUP") {
            bail!("unsupported table");
        }
        self.connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(Into::into)
    }
}

impl UnifiedGroupDatabase {
    pub fn open(path: &Path) -> Result<Self> {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let connection = Connection::open_with_flags(path, flags).with_context(|| {
            format!(
                "cannot open UnifiedGroup SQLite read-only: {}",
                path.display()
            )
        })?;
        let performance = system_performance_profile();
        connection.pragma_update(None, "query_only", true)?;
        connection.pragma_update(None, "cache_size", performance.unified_cache_kib)?;
        connection.pragma_update(None, "temp_store", "FILE")?;
        connection.pragma_update(None, "mmap_size", performance.unified_mmap_bytes)?;
        connection.pragma_update(None, "threads", performance.sqlite_workers as i64)?;
        connection.pragma_update(None, "trusted_schema", false)?;
        let group_columns = table_columns(&connection, "ZUNIFIEDGROUP")?;
        if !group_columns.contains("ZID") || !group_columns.contains("ZNAME") {
            bail!("UnifiedGroup SQLite does not contain ZUNIFIEDGROUP.ZID/ZNAME");
        }
        Ok(Self {
            connection,
            group_columns,
        })
    }

    fn chat_titles(&self, ids: &[String]) -> Result<HashMap<String, CompanionChatTitle>> {
        let mut normalized_ids = ids.iter().map(|id| lookup_id(id)).collect::<Vec<_>>();
        normalized_ids.sort_unstable();
        normalized_ids.dedup();
        let group_type = integer_expr("g", &self.group_columns, "ZTYPE", "1");
        let mut titles = HashMap::new();
        for chunk in normalized_ids.chunks(SQLITE_QUERY_BATCH_SIZE) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT CAST(g.ZID AS TEXT), CAST(g.ZNAME AS TEXT), {group_type} \
                 FROM ZUNIFIEDGROUP g \
                 WHERE LOWER(CAST(g.ZID AS TEXT)) IN ({placeholders}) \
                   AND NULLIF(CAST(g.ZNAME AS TEXT), '') IS NOT NULL"
            );
            let mut statement = self.connection.prepare(&sql)?;
            let rows = statement.query_map(
                rusqlite::params_from_iter(chunk.iter().map(String::as_str)),
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )?;
            for row in rows {
                let (id, title, group_type) = row?;
                titles.insert(
                    lookup_id(&id),
                    CompanionChatTitle {
                        title,
                        kind: chat_kind(group_type).to_string(),
                        source: "unified-group",
                    },
                );
            }
        }
        Ok(titles)
    }
}

impl LineSquareDatabase {
    pub fn open(path: &Path) -> Result<Self> {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let connection = Connection::open_with_flags(path, flags).with_context(|| {
            format!(
                "cannot open LineSquare SQLite read-only: {}",
                path.display()
            )
        })?;
        let performance = system_performance_profile();
        connection.pragma_update(None, "query_only", true)?;
        connection.pragma_update(None, "cache_size", performance.square_cache_kib)?;
        connection.pragma_update(None, "temp_store", "FILE")?;
        connection.pragma_update(None, "mmap_size", performance.square_mmap_bytes)?;
        connection.pragma_update(None, "threads", performance.sqlite_workers as i64)?;
        connection.pragma_update(None, "trusted_schema", false)?;

        let chat_columns = table_columns(&connection, "ZCHAT")?;
        let message_columns = table_columns(&connection, "ZMESSAGE")?;
        let square_columns = table_columns(&connection, "ZSQUARE")?;
        let member_columns = table_columns(&connection, "ZSQUAREMEMBER")?;
        if chat_columns.is_empty() || message_columns.is_empty() {
            bail!("LineSquare SQLite does not contain both ZCHAT and ZMESSAGE");
        }
        Ok(Self {
            connection,
            chat_columns,
            message_columns,
            square_columns,
            member_columns,
        })
    }

    pub fn for_each_searchable_message<F>(&self, mut on_record: F) -> Result<()>
    where
        F: FnMut(SearchMessageRecord) -> Result<()>,
    {
        if !self.message_columns.contains("ZCHAT") || !self.message_columns.contains("ZTEXT") {
            return Ok(());
        }
        let message_id = text_expr("m", &self.message_columns, &["ZID"]);
        let timestamp = integer_expr("m", &self.message_columns, "ZTIMESTAMP", "0");
        let sender_pk = nullable_integer_expr("m", &self.message_columns, "ZSENDER");
        let send_status = nullable_integer_expr("m", &self.message_columns, "ZSENDSTATUS");
        let content_type = nullable_integer_expr("m", &self.message_columns, "ZCONTENTTYPE");
        let message_type = text_expr("m", &self.message_columns, &["ZMESSAGETYPE"]);
        let text = text_expr("m", &self.message_columns, &["ZTEXT"]);
        let latitude = nullable_real_expr("m", &self.message_columns, "ZLATITUDE");
        let longitude = nullable_real_expr("m", &self.message_columns, "ZLONGITUDE");
        let can_join_sender =
            self.message_columns.contains("ZSENDER") && self.member_columns.contains("Z_PK");
        let sender_name = if can_join_sender {
            coalesced_text_expr("sm", &self.member_columns, &["ZDISPLAYNAME", "ZMID"])
        } else {
            "''".to_string()
        };
        let sender_id = if can_join_sender {
            text_expr("sm", &self.member_columns, &["ZMID"])
        } else {
            "''".to_string()
        };
        let join = if can_join_sender {
            " LEFT JOIN ZSQUAREMEMBER sm ON sm.Z_PK = m.ZSENDER"
        } else {
            ""
        };
        let sql = format!(
            "SELECT CAST(m.Z_PK AS INTEGER), {message_id}, CAST(m.ZCHAT AS INTEGER),
                    {timestamp}, {sender_pk}, {sender_name}, {sender_id}, {send_status},
                    {content_type}, {message_type}, {text}, {latitude}, {longitude}
             FROM ZMESSAGE m{join}
             WHERE {text} <> '' ORDER BY m.Z_PK ASC"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            on_record(search_record_from_row(row, "square")?)?;
        }
        Ok(())
    }

    pub fn chat_for_cleanup(&self, chat_pk: i64) -> Result<Chat> {
        self.cleanup_chats(Some(chat_pk), false)?
            .into_iter()
            .next()
            .context("LineSquare chat does not exist")
    }

    pub fn advanced_cleanup_chats(&self) -> Result<Vec<Chat>> {
        self.cleanup_chats(None, true)
    }

    pub fn all_chats_for_cleanup(&self) -> Result<Vec<Chat>> {
        self.cleanup_chats(None, false)
    }

    pub fn orphan_messages(&self) -> Result<Vec<OrphanMessage>> {
        if !self.message_columns.contains("ZCHAT") {
            bail!("LineSquare.ZMESSAGE does not contain ZCHAT");
        }
        let message_id = text_expr("m", &self.message_columns, &["ZID"]);
        let sql = format!(
            "SELECT CAST(m.Z_PK AS INTEGER), {message_id}, CAST(m.ZCHAT AS INTEGER) \
             FROM ZMESSAGE m \
             LEFT JOIN ZCHAT c ON c.Z_PK = m.ZCHAT \
             WHERE c.Z_PK IS NULL \
             ORDER BY m.Z_PK ASC"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map([], |row| {
            Ok(OrphanMessage {
                pk: row.get(0)?,
                id: row.get(1)?,
                chat_pk: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn cleanup_chats(&self, chat_pk: Option<i64>, filtered_only: bool) -> Result<Vec<Chat>> {
        if !self.message_columns.contains("ZCHAT") {
            bail!("LineSquare.ZMESSAGE does not contain ZCHAT");
        }
        let chat_id = text_expr("c", &self.chat_columns, &["ZMID", "ZID"]);
        let chat_type = integer_expr("c", &self.chat_columns, "ZTYPE", "100");
        let chat_name = text_expr("c", &self.chat_columns, &["ZNAME"]);
        let can_join_square =
            self.chat_columns.contains("ZSQUARE") && self.square_columns.contains("Z_PK");
        let square_name = if can_join_square {
            text_expr("s", &self.square_columns, &["ZNAME"])
        } else {
            "''".to_string()
        };
        let join = if can_join_square {
            " LEFT JOIN ZSQUARE s ON s.Z_PK = c.ZSQUARE"
        } else {
            ""
        };
        let last_updated = if self.chat_columns.contains("ZLASTUPDATED") {
            "CAST(COALESCE(c.ZLASTUPDATED, 0) AS INTEGER)".to_string()
        } else if self.message_columns.contains("ZTIMESTAMP") {
            "(SELECT CAST(COALESCE(MAX(mt.ZTIMESTAMP), 0) AS INTEGER) \
              FROM ZMESSAGE mt WHERE mt.ZCHAT = c.Z_PK)"
                .to_string()
        } else {
            "0".to_string()
        };
        let last_message = if self.chat_columns.contains("ZLASTMESSAGE") {
            text_expr("c", &self.chat_columns, &["ZLASTMESSAGE"])
        } else if self.message_columns.contains("ZTEXT") {
            "COALESCE((SELECT COALESCE(mt.ZTEXT, '') FROM ZMESSAGE mt \
              WHERE mt.ZCHAT = c.Z_PK ORDER BY mt.Z_PK DESC LIMIT 1), '')"
                .to_string()
        } else {
            "''".to_string()
        };
        let message_count =
            "(SELECT COUNT(*) FROM ZMESSAGE mc WHERE mc.ZCHAT = c.Z_PK)".to_string();
        let human_predicate = human_message_predicate("hm", &self.message_columns);
        let human_message_count = format!(
            "(SELECT COUNT(*) FROM ZMESSAGE hm \
              WHERE hm.ZCHAT = c.Z_PK AND {human_predicate})"
        );
        let sql = format!(
            "SELECT CAST(c.Z_PK AS INTEGER), {chat_id}, {chat_type}, {chat_name}, \
                    {square_name}, {message_count}, {human_message_count}, \
                    {last_updated}, {last_message} \
             FROM ZCHAT c{join} \
             WHERE (?1 IS NULL OR c.Z_PK = ?1) \
               AND (?2 = 0 OR {message_count} = 0 OR {human_message_count} = 0) \
             ORDER BY c.Z_PK ASC"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(params![chat_pk, i64::from(filtered_only)], |row| {
            let id: String = row.get(1)?;
            let chat_name: String = row.get(3)?;
            let square_name: String = row.get(4)?;
            let title = if !square_name.is_empty() {
                square_name
            } else if !chat_name.is_empty() {
                chat_name
            } else if !id.is_empty() {
                id.clone()
            } else {
                "未命名社群".to_string()
            };
            Ok(Chat {
                pk: row.get(0)?,
                source: "square".to_string(),
                id,
                chat_type: row.get(2)?,
                kind: "community".to_string(),
                title,
                title_source: "line-square".to_string(),
                message_count: row.get(5)?,
                human_message_count: row.get(6)?,
                last_updated: row.get(7)?,
                last_message: row.get(8)?,
                planned_for_removal: false,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_chats(&self, cursor: Option<ChatCursor>, limit: u32) -> Result<ChatPage> {
        self.list_chats_with_boundaries(cursor, None, limit)
    }

    pub fn chats_for_index(&self) -> Result<Vec<Chat>> {
        if !self.message_columns.contains("ZCHAT") {
            return Ok(Vec::new());
        }
        let chat_id = text_expr("c", &self.chat_columns, &["ZMID", "ZID"]);
        let chat_type = integer_expr("c", &self.chat_columns, "ZTYPE", "100");
        let chat_name = text_expr("c", &self.chat_columns, &["ZNAME"]);
        let can_join_square =
            self.chat_columns.contains("ZSQUARE") && self.square_columns.contains("Z_PK");
        let square_name = if can_join_square {
            text_expr("s", &self.square_columns, &["ZNAME"])
        } else {
            "''".to_string()
        };
        let square_join = if can_join_square {
            " LEFT JOIN ZSQUARE s ON s.Z_PK = c.ZSQUARE"
        } else {
            ""
        };
        let timestamp = integer_expr("m", &self.message_columns, "ZTIMESTAMP", "0");
        let human_predicate = human_message_predicate("m", &self.message_columns);
        let last_updated = if self.chat_columns.contains("ZLASTUPDATED") {
            "CAST(COALESCE(c.ZLASTUPDATED, 0) AS INTEGER)".to_string()
        } else {
            "CAST(COALESCE(stats.last_updated, 0) AS INTEGER)".to_string()
        };
        let (message_count, stats_join) = if self.chat_columns.contains("ZMESSAGECOUNT") {
            (
                "CAST(COALESCE(c.ZMESSAGECOUNT, 0) AS INTEGER)".to_string(),
                "LEFT JOIN",
            )
        } else {
            ("stats.message_count".to_string(), "JOIN")
        };
        let (latest_message_cte, latest_message_join, last_message) =
            if self.chat_columns.contains("ZLASTMESSAGE") {
                (
                    String::new(),
                    "",
                    text_expr("c", &self.chat_columns, &["ZLASTMESSAGE"]),
                )
            } else if self.message_columns.contains("ZTEXT") {
                let latest_timestamp =
                    integer_expr("latest", &self.message_columns, "ZTIMESTAMP", "0");
                (
                    format!(
                        ",
                        latest_messages AS (
                            SELECT chat_pk, text
                            FROM (
                                SELECT CAST(latest.ZCHAT AS INTEGER) AS chat_pk,
                                       CAST(COALESCE(latest.ZTEXT, '') AS TEXT) AS text,
                                       ROW_NUMBER() OVER (
                                           PARTITION BY latest.ZCHAT
                                           ORDER BY {latest_timestamp} DESC, latest.Z_PK DESC
                                       ) AS position
                                FROM ZMESSAGE latest
                            )
                            WHERE position = 1
                        )"
                    ),
                    " LEFT JOIN latest_messages latest_message ON latest_message.chat_pk = c.Z_PK",
                    "COALESCE(latest_message.text, '')".to_string(),
                )
            } else {
                (String::new(), "", "''".to_string())
            };
        let sql = format!(
            "
            WITH message_stats AS (
                SELECT CAST(m.ZCHAT AS INTEGER) AS chat_pk,
                       COUNT(*) AS message_count,
                       SUM(CASE WHEN {human_predicate} THEN 1 ELSE 0 END)
                           AS human_message_count,
                       MAX({timestamp}) AS last_updated
                FROM ZMESSAGE m
                GROUP BY m.ZCHAT
            )
            {latest_message_cte}
            SELECT CAST(c.Z_PK AS INTEGER), {chat_id}, {chat_type}, {chat_name},
                   {square_name}, {message_count},
                   CAST(COALESCE(stats.human_message_count, 0) AS INTEGER),
                   {last_updated}, {last_message}
            FROM ZCHAT c
            {stats_join} message_stats stats ON stats.chat_pk = c.Z_PK
            {square_join}
            {latest_message_join}
            WHERE {message_count} > 0
            ORDER BY {last_updated} DESC, c.Z_PK ASC
            "
        );
        let mut statement = self.connection.prepare(&sql)?;
        let mut rows = statement.query([])?;
        let mut chats = Vec::new();
        while let Some(row) = rows.next()? {
            let id: String = row.get(1)?;
            let chat_name: String = row.get(3)?;
            let square_name: String = row.get(4)?;
            let (title, title_source) = if !square_name.is_empty() {
                (square_name, "line-square".to_string())
            } else if !chat_name.is_empty() {
                (chat_name, "chat".to_string())
            } else if !id.is_empty() {
                (id.clone(), "id".to_string())
            } else {
                ("未命名社群".to_string(), "unresolved".to_string())
            };
            chats.push(Chat {
                pk: row.get(0)?,
                source: "square".to_string(),
                id,
                chat_type: row.get(2)?,
                kind: "community".to_string(),
                title,
                title_source,
                message_count: row.get(5)?,
                human_message_count: row.get(6)?,
                last_updated: row.get(7)?,
                last_message: row.get(8)?,
                planned_for_removal: false,
            });
        }
        Ok(chats)
    }

    pub fn list_chats_before(&self, cursor: ChatCursor, limit: u32) -> Result<ChatPage> {
        self.list_chats_with_boundaries(None, Some(cursor), limit)
    }

    fn list_chats_with_boundaries(
        &self,
        after_cursor: Option<ChatCursor>,
        before_cursor: Option<ChatCursor>,
        limit: u32,
    ) -> Result<ChatPage> {
        if after_cursor.is_some() && before_cursor.is_some() {
            bail!("chat pagination cannot use both after and before cursors");
        }
        let limit = checked_page_size(limit)?;
        let chat_id = text_expr("c", &self.chat_columns, &["ZMID", "ZID"]);
        let chat_type = integer_expr("c", &self.chat_columns, "ZTYPE", "100");
        let chat_name = text_expr("c", &self.chat_columns, &["ZNAME"]);
        let can_join_square =
            self.chat_columns.contains("ZSQUARE") && self.square_columns.contains("Z_PK");
        let square_name = if can_join_square {
            text_expr("s", &self.square_columns, &["ZNAME"])
        } else {
            "''".to_string()
        };
        let join = if can_join_square {
            " LEFT JOIN ZSQUARE s ON s.Z_PK = c.ZSQUARE"
        } else {
            ""
        };
        let last_updated = if self.chat_columns.contains("ZLASTUPDATED") {
            "CAST(COALESCE(c.ZLASTUPDATED, 0) AS INTEGER)".to_string()
        } else if self.message_columns.contains("ZTIMESTAMP")
            && self.message_columns.contains("ZCHAT")
        {
            "(SELECT CAST(COALESCE(MAX(mt.ZTIMESTAMP), 0) AS INTEGER) FROM ZMESSAGE mt WHERE mt.ZCHAT = c.Z_PK)".to_string()
        } else {
            "0".to_string()
        };
        let last_message = if self.chat_columns.contains("ZLASTMESSAGE") {
            text_expr("c", &self.chat_columns, &["ZLASTMESSAGE"])
        } else if self.message_columns.contains("ZTEXT")
            && self.message_columns.contains("ZCHAT")
            && self.message_columns.contains("ZTIMESTAMP")
        {
            "(SELECT COALESCE(mt.ZTEXT, '') FROM ZMESSAGE mt WHERE mt.ZCHAT = c.Z_PK ORDER BY COALESCE(mt.ZTIMESTAMP, 0) DESC, mt.Z_PK DESC LIMIT 1)".to_string()
        } else {
            "''".to_string()
        };
        let message_count = if self.chat_columns.contains("ZMESSAGECOUNT") {
            "CAST(COALESCE(c.ZMESSAGECOUNT, 0) AS INTEGER)".to_string()
        } else if self.message_columns.contains("ZCHAT") {
            "(SELECT COUNT(*) FROM ZMESSAGE mc WHERE mc.ZCHAT = c.Z_PK)".to_string()
        } else {
            "0".to_string()
        };
        let human_message_count = if self.message_columns.contains("ZCHAT") {
            let predicate = human_message_predicate("hm", &self.message_columns);
            format!("(SELECT COUNT(*) FROM ZMESSAGE hm WHERE hm.ZCHAT = c.Z_PK AND {predicate})")
        } else {
            "0".to_string()
        };
        let boundary = after_cursor.as_ref().or(before_cursor.as_ref());
        let cursor_filter = if let Some(cursor) = boundary {
            let tie_filter = if before_cursor.is_some() {
                source_cursor_before_filter("square", &cursor.source, "c.Z_PK", "?2")
            } else {
                source_cursor_tie_filter("square", &cursor.source, "c.Z_PK", "?2")
            };
            format!(
                " WHERE {message_count} > 0 \
                 AND ({last_updated} {} ?1 OR ({last_updated} = ?1 AND {tie_filter}))",
                if before_cursor.is_some() { ">" } else { "<" }
            )
        } else {
            format!(" WHERE {message_count} > 0")
        };
        let order_by = if before_cursor.is_some() {
            format!(" ORDER BY {last_updated} ASC, c.Z_PK DESC")
        } else {
            format!(" ORDER BY {last_updated} DESC, c.Z_PK ASC")
        };
        let sql = format!(
            "SELECT CAST(c.Z_PK AS INTEGER), {chat_id}, {chat_type}, {chat_name}, \
             {square_name}, {message_count}, {human_message_count}, {last_updated}, \
             {last_message} FROM ZCHAT c{join}{cursor_filter} \
             {order_by} LIMIT ?3"
        );
        let cursor = boundary.cloned().unwrap_or(ChatCursor {
            last_updated: i64::MAX,
            source: "line".to_string(),
            pk: 0,
        });
        let mut statement = self.connection.prepare(&sql)?;
        let mut rows =
            statement.query(params![cursor.last_updated, cursor.pk, limit as i64 + 1])?;
        let mut items = Vec::with_capacity(limit);
        while let Some(row) = rows.next()? {
            let id: String = row.get(1)?;
            let chat_name: String = row.get(3)?;
            let square_name: String = row.get(4)?;
            let (title, title_source) = if !square_name.is_empty() {
                (square_name, "line-square".to_string())
            } else if !chat_name.is_empty() {
                (chat_name, "chat".to_string())
            } else if !id.is_empty() {
                (id.clone(), "id".to_string())
            } else {
                ("未命名社群".to_string(), "unresolved".to_string())
            };
            items.push(Chat {
                pk: row.get(0)?,
                source: "square".to_string(),
                id,
                chat_type: row.get(2)?,
                kind: "community".to_string(),
                title,
                title_source,
                message_count: row.get(5)?,
                human_message_count: row.get(6)?,
                last_updated: row.get(7)?,
                last_message: row.get(8)?,
                planned_for_removal: false,
            });
        }
        let has_extra = items.len() > limit;
        if has_extra {
            items.pop();
        }
        if before_cursor.is_some() {
            items.reverse();
        }
        let next_cursor = if (before_cursor.is_some() && !items.is_empty()) || has_extra {
            items.last().map(|chat| ChatCursor {
                last_updated: chat.last_updated,
                source: chat.source.clone(),
                pk: chat.pk,
            })
        } else {
            None
        };
        let has_previous = if before_cursor.is_some() {
            has_extra
        } else {
            after_cursor.is_some()
        };
        Ok(ChatPage {
            items,
            next_cursor,
            has_previous,
        })
    }

    pub fn list_messages(
        &self,
        chat_pk: i64,
        cursor: Option<MessageCursor>,
        limit: u32,
        account_id: Option<&str>,
    ) -> Result<MessagePage> {
        self.list_messages_with_boundaries(chat_pk, cursor, None, limit, account_id)
    }

    pub fn list_messages_before(
        &self,
        chat_pk: i64,
        cursor: MessageCursor,
        limit: u32,
        account_id: Option<&str>,
    ) -> Result<MessagePage> {
        self.list_messages_with_boundaries(chat_pk, None, Some(cursor), limit, account_id)
    }

    fn list_messages_with_boundaries(
        &self,
        chat_pk: i64,
        after_cursor: Option<MessageCursor>,
        before_cursor: Option<MessageCursor>,
        limit: u32,
        account_id: Option<&str>,
    ) -> Result<MessagePage> {
        if after_cursor.is_some() && before_cursor.is_some() {
            bail!("message pagination cannot use both after and before cursors");
        }
        let limit = checked_page_size(limit)?;
        if !self.message_columns.contains("ZCHAT") {
            bail!("LineSquare.ZMESSAGE does not contain ZCHAT");
        }
        let message_id = text_expr("m", &self.message_columns, &["ZID"]);
        let timestamp = integer_expr("m", &self.message_columns, "ZTIMESTAMP", "0");
        let sender_pk = nullable_integer_expr("m", &self.message_columns, "ZSENDER");
        let send_status = nullable_integer_expr("m", &self.message_columns, "ZSENDSTATUS");
        let content_type = nullable_integer_expr("m", &self.message_columns, "ZCONTENTTYPE");
        let message_type = text_expr("m", &self.message_columns, &["ZMESSAGETYPE"]);
        let text = text_expr("m", &self.message_columns, &["ZTEXT"]);
        let latitude = nullable_real_expr("m", &self.message_columns, "ZLATITUDE");
        let longitude = nullable_real_expr("m", &self.message_columns, "ZLONGITUDE");
        let can_join_sender =
            self.message_columns.contains("ZSENDER") && self.member_columns.contains("Z_PK");
        let sender_name = if can_join_sender {
            coalesced_text_expr("sm", &self.member_columns, &["ZDISPLAYNAME", "ZMID"])
        } else {
            "''".to_string()
        };
        let sender_id = if can_join_sender {
            text_expr("sm", &self.member_columns, &["ZMID"])
        } else {
            "''".to_string()
        };
        let join = if can_join_sender {
            " LEFT JOIN ZSQUAREMEMBER sm ON sm.Z_PK = m.ZSENDER"
        } else {
            ""
        };
        let sql = format!(
            "SELECT CAST(m.Z_PK AS INTEGER), {message_id}, CAST(m.ZCHAT AS INTEGER), \
             {timestamp}, {sender_pk}, {sender_name}, {sender_id}, {send_status}, {content_type}, \
             {message_type}, {text}, {latitude}, {longitude} \
             FROM ZMESSAGE m{join} \
             WHERE m.ZCHAT = ?1 AND ({timestamp} {} ?2 OR ({timestamp} = ?2 AND m.Z_PK {} ?3)) \
             ORDER BY {timestamp} {}, m.Z_PK {} LIMIT ?4",
            if before_cursor.is_some() { "<" } else { ">" },
            if before_cursor.is_some() { "<" } else { ">" },
            if before_cursor.is_some() {
                "DESC"
            } else {
                "ASC"
            },
            if before_cursor.is_some() {
                "DESC"
            } else {
                "ASC"
            }
        );
        let cursor = after_cursor.or(before_cursor).unwrap_or(MessageCursor {
            timestamp: i64::MIN,
            pk: 0,
        });
        let mut statement = self.connection.prepare(&sql)?;
        let mut rows = statement.query(params![
            chat_pk,
            cursor.timestamp,
            cursor.pk,
            limit as i64 + 1
        ])?;
        let mut items = Vec::with_capacity(limit);
        while let Some(row) = rows.next()? {
            items.push(message_from_row(row, "square", account_id)?);
        }
        let has_extra = items.len() > limit;
        if has_extra {
            items.pop();
        }
        if before_cursor.is_some() {
            items.reverse();
        }
        let next_cursor = if (before_cursor.is_some() && !items.is_empty()) || has_extra {
            items.last().map(|message| MessageCursor {
                timestamp: message.timestamp,
                pk: message.pk,
            })
        } else {
            None
        };
        let has_previous = if before_cursor.is_some() {
            has_extra
        } else {
            after_cursor.is_some()
        };
        Ok(MessagePage {
            items,
            next_cursor,
            has_previous,
        })
    }

    pub fn search_messages(
        &self,
        query: &str,
        chat_pk: Option<i64>,
        cursor: Option<MessageCursor>,
        limit: u32,
        account_id: Option<&str>,
    ) -> Result<MessagePage> {
        self.search_messages_with_boundaries(query, chat_pk, cursor, None, limit, account_id)
    }

    pub fn search_messages_before(
        &self,
        query: &str,
        chat_pk: Option<i64>,
        cursor: MessageCursor,
        limit: u32,
        account_id: Option<&str>,
    ) -> Result<MessagePage> {
        self.search_messages_with_boundaries(query, chat_pk, None, Some(cursor), limit, account_id)
    }

    fn search_messages_with_boundaries(
        &self,
        query: &str,
        chat_pk: Option<i64>,
        after_cursor: Option<MessageCursor>,
        before_cursor: Option<MessageCursor>,
        limit: u32,
        account_id: Option<&str>,
    ) -> Result<MessagePage> {
        if after_cursor.is_some() && before_cursor.is_some() {
            bail!("message search pagination cannot use both after and before cursors");
        }
        let query = validated_search_pattern(query)?;
        let limit = checked_page_size(limit)?;
        if !self.message_columns.contains("ZCHAT") || !self.message_columns.contains("ZTEXT") {
            bail!("LineSquare.ZMESSAGE does not contain searchable chat text");
        }
        let message_id = text_expr("m", &self.message_columns, &["ZID"]);
        let timestamp = integer_expr("m", &self.message_columns, "ZTIMESTAMP", "0");
        let sender_pk = nullable_integer_expr("m", &self.message_columns, "ZSENDER");
        let send_status = nullable_integer_expr("m", &self.message_columns, "ZSENDSTATUS");
        let content_type = nullable_integer_expr("m", &self.message_columns, "ZCONTENTTYPE");
        let message_type = text_expr("m", &self.message_columns, &["ZMESSAGETYPE"]);
        let text = text_expr("m", &self.message_columns, &["ZTEXT"]);
        let latitude = nullable_real_expr("m", &self.message_columns, "ZLATITUDE");
        let longitude = nullable_real_expr("m", &self.message_columns, "ZLONGITUDE");
        let can_join_sender =
            self.message_columns.contains("ZSENDER") && self.member_columns.contains("Z_PK");
        let sender_name = if can_join_sender {
            coalesced_text_expr("sm", &self.member_columns, &["ZDISPLAYNAME", "ZMID"])
        } else {
            "''".to_string()
        };
        let sender_id = if can_join_sender {
            text_expr("sm", &self.member_columns, &["ZMID"])
        } else {
            "''".to_string()
        };
        let join = if can_join_sender {
            " LEFT JOIN ZSQUAREMEMBER sm ON sm.Z_PK = m.ZSENDER"
        } else {
            ""
        };
        let sql = format!(
            "SELECT CAST(m.Z_PK AS INTEGER), {message_id}, CAST(m.ZCHAT AS INTEGER), \
             {timestamp}, {sender_pk}, {sender_name}, {sender_id}, {send_status}, {content_type}, \
             {message_type}, {text}, {latitude}, {longitude} \
             FROM ZMESSAGE m{join} \
             WHERE {text} LIKE ?1 ESCAPE '\\' \
               AND (?2 IS NULL OR m.ZCHAT = ?2) \
               AND ({timestamp} {} ?3 OR ({timestamp} = ?3 AND m.Z_PK {} ?4)) \
             ORDER BY {timestamp} {}, m.Z_PK {} LIMIT ?5",
            if before_cursor.is_some() { "<" } else { ">" },
            if before_cursor.is_some() { "<" } else { ">" },
            if before_cursor.is_some() {
                "DESC"
            } else {
                "ASC"
            },
            if before_cursor.is_some() {
                "DESC"
            } else {
                "ASC"
            }
        );
        let cursor = after_cursor.or(before_cursor).unwrap_or(MessageCursor {
            timestamp: i64::MIN,
            pk: 0,
        });
        let mut statement = self.connection.prepare(&sql)?;
        let mut rows = statement.query(params![
            query,
            chat_pk,
            cursor.timestamp,
            cursor.pk,
            limit as i64 + 1
        ])?;
        let mut items = Vec::with_capacity(limit);
        while let Some(row) = rows.next()? {
            items.push(message_from_row(row, "square", account_id)?);
        }
        let has_extra = items.len() > limit;
        if has_extra {
            items.pop();
        }
        if before_cursor.is_some() {
            items.reverse();
        }
        let next_cursor = if (before_cursor.is_some() && !items.is_empty()) || has_extra {
            items.last().map(|message| MessageCursor {
                timestamp: message.timestamp,
                pk: message.pk,
            })
        } else {
            None
        };
        let has_previous = if before_cursor.is_some() {
            has_extra
        } else {
            after_cursor.is_some()
        };
        Ok(MessagePage {
            items,
            next_cursor,
            has_previous,
        })
    }

    pub fn attachment_contexts(
        &self,
        message_ids: &[String],
    ) -> Result<HashMap<String, Vec<AttachmentContext>>> {
        if message_ids.len() > MAX_PAGE_SIZE as usize {
            bail!("attachment context batch cannot exceed {MAX_PAGE_SIZE} message IDs");
        }
        if message_ids.is_empty()
            || !self.message_columns.contains("ZID")
            || !self.message_columns.contains("ZCHAT")
        {
            return Ok(HashMap::new());
        }
        let timestamp = integer_expr("m", &self.message_columns, "ZTIMESTAMP", "0");
        let sender_pk = nullable_integer_expr("m", &self.message_columns, "ZSENDER");
        let content_type = nullable_integer_expr("m", &self.message_columns, "ZCONTENTTYPE");
        let text = text_expr("m", &self.message_columns, &["ZTEXT"]);
        let chat_id = text_expr("c", &self.chat_columns, &["ZMID", "ZID"]);
        let chat_name = text_expr("c", &self.chat_columns, &["ZNAME"]);
        let can_join_square =
            self.chat_columns.contains("ZSQUARE") && self.square_columns.contains("Z_PK");
        let square_name = if can_join_square {
            text_expr("s", &self.square_columns, &["ZNAME"])
        } else {
            "''".to_string()
        };
        let can_join_sender =
            self.message_columns.contains("ZSENDER") && self.member_columns.contains("Z_PK");
        let sender_name = if can_join_sender {
            coalesced_text_expr("sm", &self.member_columns, &["ZDISPLAYNAME", "ZMID"])
        } else {
            "''".to_string()
        };
        let joins = format!(
            " LEFT JOIN ZCHAT c ON c.Z_PK = m.ZCHAT{}{}",
            if can_join_square {
                " LEFT JOIN ZSQUARE s ON s.Z_PK = c.ZSQUARE"
            } else {
                ""
            },
            if can_join_sender {
                " LEFT JOIN ZSQUAREMEMBER sm ON sm.Z_PK = m.ZSENDER"
            } else {
                ""
            }
        );
        let mut contexts: HashMap<String, Vec<AttachmentContext>> = HashMap::new();
        for chunk in message_ids.chunks(SQLITE_QUERY_BATCH_SIZE) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT CAST(m.Z_PK AS INTEGER), CAST(m.ZID AS TEXT), \
                 CAST(m.ZCHAT AS INTEGER), {timestamp}, {sender_pk}, {sender_name}, \
                 {content_type}, {text}, {chat_id}, {chat_name}, {square_name} \
                 FROM ZMESSAGE m{joins} \
                 WHERE m.ZID IN ({placeholders}) \
                 ORDER BY m.Z_PK ASC"
            );
            let mut statement = self.connection.prepare(&sql)?;
            let mut rows =
                statement.query(rusqlite::params_from_iter(chunk.iter().map(String::as_str)))?;
            while let Some(row) = rows.next()? {
                let message_id: String = row.get(1)?;
                let chat_id: String = row.get(8)?;
                let chat_name: String = row.get(9)?;
                let square_name: String = row.get(10)?;
                let chat_title = if !square_name.is_empty() {
                    square_name
                } else if !chat_name.is_empty() {
                    chat_name
                } else if !chat_id.is_empty() {
                    chat_id.clone()
                } else {
                    "未命名社群".to_string()
                };
                contexts
                    .entry(message_id)
                    .or_default()
                    .push(AttachmentContext {
                        source: "square".to_string(),
                        message_pk: row.get(0)?,
                        chat_pk: row.get(2)?,
                        chat_id,
                        chat_title,
                        chat_kind: "community".to_string(),
                        timestamp: row.get(3)?,
                        sender_pk: row.get(4)?,
                        sender_name: row.get(5)?,
                        content_type: row.get(6)?,
                        text: row.get(7)?,
                    });
            }
        }
        Ok(contexts)
    }

    fn chat_titles(&self, ids: &[String]) -> Result<HashMap<String, CompanionChatTitle>> {
        if !self.chat_columns.contains("ZMID") {
            return Ok(HashMap::new());
        }
        let mut normalized_ids = ids.iter().map(|id| lookup_id(id)).collect::<Vec<_>>();
        normalized_ids.sort_unstable();
        normalized_ids.dedup();
        let can_join_square =
            self.chat_columns.contains("ZSQUARE") && self.square_columns.contains("Z_PK");
        let chat_name = text_expr("c", &self.chat_columns, &["ZNAME"]);
        let square_name = if can_join_square {
            text_expr("s", &self.square_columns, &["ZNAME"])
        } else {
            "''".to_string()
        };
        let join = if can_join_square {
            " LEFT JOIN ZSQUARE s ON s.Z_PK = c.ZSQUARE"
        } else {
            ""
        };
        let mut titles = HashMap::new();
        for chunk in normalized_ids.chunks(SQLITE_QUERY_BATCH_SIZE) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT CAST(c.ZMID AS TEXT), {chat_name}, {square_name} \
                 FROM ZCHAT c{join} \
                 WHERE LOWER(CAST(c.ZMID AS TEXT)) IN ({placeholders})"
            );
            let mut statement = self.connection.prepare(&sql)?;
            let rows = statement.query_map(
                rusqlite::params_from_iter(chunk.iter().map(String::as_str)),
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )?;
            for row in rows {
                let (id, chat_name, square_name) = row?;
                let title = if square_name.is_empty() {
                    chat_name
                } else {
                    square_name
                };
                if title.is_empty() {
                    continue;
                }
                titles.insert(
                    lookup_id(&id),
                    CompanionChatTitle {
                        title,
                        kind: "community".to_string(),
                        source: "line-square",
                    },
                );
            }
        }
        Ok(titles)
    }
}

fn source_cursor_tie_filter(
    source: &str,
    cursor_source: &str,
    pk_expression: &str,
    pk_parameter: &str,
) -> String {
    match source.cmp(cursor_source) {
        std::cmp::Ordering::Greater => "1 = 1".to_string(),
        std::cmp::Ordering::Equal => format!("{pk_expression} > {pk_parameter}"),
        std::cmp::Ordering::Less => "1 = 0".to_string(),
    }
}

fn source_cursor_before_filter(
    source: &str,
    cursor_source: &str,
    pk_expression: &str,
    pk_parameter: &str,
) -> String {
    match source.cmp(cursor_source) {
        std::cmp::Ordering::Greater => "1 = 0".to_string(),
        std::cmp::Ordering::Equal => format!("{pk_expression} < {pk_parameter}"),
        std::cmp::Ordering::Less => "1 = 1".to_string(),
    }
}

fn search_record_from_row(
    row: &Row<'_>,
    source: &'static str,
) -> rusqlite::Result<SearchMessageRecord> {
    Ok(SearchMessageRecord {
        source,
        pk: row.get(0)?,
        id: row.get(1)?,
        chat_pk: row.get(2)?,
        timestamp: row.get(3)?,
        sender_pk: row.get(4)?,
        sender_name: row.get(5)?,
        sender_id: row.get(6)?,
        send_status: row.get(7)?,
        content_type: row.get(8)?,
        message_type: row.get(9)?,
        text: row.get(10)?,
        latitude: row.get(11)?,
        longitude: row.get(12)?,
    })
}

fn message_from_row(
    row: &Row<'_>,
    source: &str,
    account_id: Option<&str>,
) -> rusqlite::Result<Message> {
    let id: String = row.get(1)?;
    let sender_pk: Option<i64> = row.get(4)?;
    let sender_name: String = row.get(5)?;
    let sender_id: String = row.get(6)?;
    let send_status: Option<i64> = row.get(7)?;
    let content_type: Option<i64> = row.get(8)?;
    let message_type: String = row.get(9)?;
    let is_system = content_type.is_some_and(|value| [7, 18, 96, 111].contains(&value))
        || (sender_pk.is_none() && send_status == Some(0) && id.is_empty());
    let is_self = account_id.is_some_and(|account| !sender_id.is_empty() && sender_id == account)
        || (sender_pk.is_none()
            && !is_system
            && (send_status == Some(1) || message_type.eq_ignore_ascii_case("S")));
    Ok(Message {
        pk: row.get(0)?,
        source: source.to_string(),
        id,
        chat_pk: row.get(2)?,
        timestamp: row.get(3)?,
        sender_pk,
        sender_name,
        is_self,
        send_status,
        content_type,
        message_type,
        text: row.get(10)?,
        latitude: row.get(11)?,
        longitude: row.get(12)?,
        attachments: Vec::new(),
    })
}

fn message_from_fts_row(
    row: &Row<'_>,
    source: &str,
    account_id: Option<&str>,
) -> rusqlite::Result<Message> {
    let id: String = row.get(1)?;
    let sender_pk: Option<i64> = row.get(4)?;
    let sender_name: String = row.get(5)?;
    let sender_id: String = row.get(6)?;
    let send_status: Option<i64> = row.get(7)?;
    let content_type: Option<i64> = row.get(8)?;
    let message_type: String = row.get(9)?;
    let is_system = content_type.is_some_and(|value| [7, 18, 96, 111].contains(&value))
        || (sender_pk.is_none() && send_status == Some(0) && id.is_empty());
    let is_self = account_id.is_some_and(|account| !sender_id.is_empty() && sender_id == account)
        || (sender_pk.is_none()
            && !is_system
            && (send_status == Some(1) || message_type.eq_ignore_ascii_case("S")));
    Ok(Message {
        pk: row.get(0)?,
        source: source.to_string(),
        id,
        chat_pk: row.get(2)?,
        timestamp: row.get(3)?,
        sender_pk,
        sender_name,
        is_self,
        send_status,
        content_type,
        message_type,
        text: row.get(10)?,
        latitude: row.get(11)?,
        longitude: row.get(12)?,
        attachments: Vec::new(),
    })
}

fn table_columns(connection: &Connection, table: &str) -> Result<HashSet<String>> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(HashSet::new());
    }
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(rows
        .collect::<rusqlite::Result<HashSet<_>>>()?
        .into_iter()
        .map(|name| name.to_ascii_uppercase())
        .collect())
}

fn text_expr(alias: &str, columns: &HashSet<String>, candidates: &[&str]) -> String {
    let expressions: Vec<String> = candidates
        .iter()
        .filter(|name| columns.contains(**name))
        .map(|name| format!("CAST({alias}.{name} AS TEXT)"))
        .collect();
    if expressions.is_empty() {
        "''".to_string()
    } else {
        format!("COALESCE({}, '')", expressions.join(", "))
    }
}

fn coalesced_text_expr(alias: &str, columns: &HashSet<String>, candidates: &[&str]) -> String {
    let expressions: Vec<String> = candidates
        .iter()
        .filter(|name| columns.contains(**name))
        .map(|name| format!("NULLIF(CAST({alias}.{name} AS TEXT), '')"))
        .collect();
    if expressions.is_empty() {
        "''".to_string()
    } else {
        format!("COALESCE({}, '')", expressions.join(", "))
    }
}

fn integer_expr(alias: &str, columns: &HashSet<String>, column: &str, fallback: &str) -> String {
    if columns.contains(column) {
        format!("CAST(COALESCE({alias}.{column}, {fallback}) AS INTEGER)")
    } else {
        fallback.to_string()
    }
}

fn nullable_integer_expr(alias: &str, columns: &HashSet<String>, column: &str) -> String {
    if columns.contains(column) {
        format!("CAST({alias}.{column} AS INTEGER)")
    } else {
        "NULL".to_string()
    }
}

fn nullable_real_expr(alias: &str, columns: &HashSet<String>, column: &str) -> String {
    if columns.contains(column) {
        format!("CAST({alias}.{column} AS REAL)")
    } else {
        "NULL".to_string()
    }
}

fn validated_search_pattern(query: &str) -> Result<String> {
    let query = query.trim();
    if query.is_empty() {
        bail!("search query cannot be empty");
    }
    if query.len() > 1_024 {
        bail!("search query cannot exceed 1,024 UTF-8 bytes");
    }
    Ok(format!(
        "%{}%",
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    ))
}

fn validated_fts_pattern(query: &str) -> Result<String> {
    let query = query.trim();
    if query.is_empty() {
        bail!("search query cannot be empty");
    }
    if query.len() > 1_024 {
        bail!("search query cannot exceed 1,024 UTF-8 bytes");
    }
    Ok(format!("\"{}\"*", query.replace('"', "\"\"")))
}

fn human_message_predicate(alias: &str, message_columns: &HashSet<String>) -> String {
    let mut conditions = Vec::new();
    if message_columns.contains("ZCONTENTTYPE") {
        conditions.push(format!(
            "({alias}.ZCONTENTTYPE IS NULL OR CAST({alias}.ZCONTENTTYPE AS INTEGER) NOT IN (7, 18, 96, 111))"
        ));
    }
    if message_columns.contains("ZSENDER")
        && message_columns.contains("ZSENDSTATUS")
        && message_columns.contains("ZID")
    {
        conditions.push(format!(
            "NOT (({alias}.ZSENDER IS NULL OR CAST({alias}.ZSENDER AS TEXT) = '') \
             AND CAST(COALESCE({alias}.ZSENDSTATUS, 0) AS INTEGER) = 0 \
             AND ({alias}.ZID IS NULL OR CAST({alias}.ZID AS TEXT) = ''))"
        ));
    }
    if conditions.is_empty() {
        "1".to_string()
    } else {
        conditions.join(" AND ")
    }
}

fn group_rename_text_expr(
    chat_expression: &str,
    message_columns: &HashSet<String>,
    alias: &str,
) -> String {
    if !message_columns.contains("ZCHAT")
        || !message_columns.contains("ZCONTENTTYPE")
        || !message_columns.contains("ZTEXT")
    {
        return "''".to_string();
    }
    let timestamp = integer_expr(alias, message_columns, "ZTIMESTAMP", "0");
    format!(
        "COALESCE((SELECT CAST({alias}.ZTEXT AS TEXT) FROM ZMESSAGE {alias} \
         WHERE {alias}.ZCHAT = {chat_expression} \
           AND CAST({alias}.ZCONTENTTYPE AS INTEGER) = 18 \
           AND {alias}.ZTEXT IS NOT NULL \
           AND ({alias}.ZTEXT LIKE '%群組名稱%' OR LOWER(CAST({alias}.ZTEXT AS TEXT)) LIKE '%group%name%') \
         ORDER BY {timestamp} DESC, {alias}.Z_PK DESC LIMIT 1), '')"
    )
}

fn extract_group_name_from_system_text(value: &str) -> String {
    let cleaned = value
        .replace(['\u{2068}', '\u{2069}', '\u{200b}', '\u{feff}'], "")
        .trim()
        .to_string();
    let lower = cleaned.to_lowercase();
    let marker = cleaned
        .find("群組名稱")
        .or_else(|| lower.find("group name"));
    let Some(marker) = marker else {
        return String::new();
    };
    let tail = &cleaned[marker..];
    for (open, close) in [('「', '」'), ('『', '』'), ('“', '”'), ('"', '"')] {
        let Some(open_index) = tail.find(open) else {
            continue;
        };
        let content = &tail[open_index + open.len_utf8()..];
        let Some(close_index) = content.find(close) else {
            continue;
        };
        let title = content[..close_index].trim();
        if !title.is_empty() {
            return title.to_string();
        }
    }
    String::new()
}

fn lookup_id(value: &str) -> String {
    value.trim().to_lowercase()
}

fn chat_kind(chat_type: i64) -> &'static str {
    match chat_type {
        0 => "direct",
        1 | 2 | 4 => "group",
        100 => "community",
        _ => "unknown",
    }
}
