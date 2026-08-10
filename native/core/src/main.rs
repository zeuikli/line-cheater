use std::io::{BufReader, BufWriter};
use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use line_backup_native::{
    AttachmentCursor, AttachmentKind, CandidateOptions, Catalog, ChatCursor, DuplicateGroupCursor,
    LineDatabase, LineSquareDatabase, MessageCursor, NativeSession, UnifiedGroupDatabase,
    build_candidate_with_options, inspect_source, prepare_source, serve,
};
use serde::Serialize;

#[derive(Debug, Parser)]
#[command(version, about)]
struct Cli {
    #[arg(long, default_value = ".line-reader-work", global = true)]
    work_dir: PathBuf,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Inspect {
        #[arg(long)]
        source: PathBuf,
    },
    Chats {
        #[arg(long)]
        source: PathBuf,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long)]
        after_updated: Option<i64>,
        #[arg(long)]
        after_pk: Option<i64>,
    },
    Messages {
        #[arg(long)]
        source: PathBuf,
        #[arg(long)]
        chat_pk: i64,
        #[arg(long, default_value_t = 180)]
        limit: u32,
        #[arg(long)]
        after_timestamp: Option<i64>,
        #[arg(long)]
        after_pk: Option<i64>,
    },
    Search {
        #[arg(long)]
        source: PathBuf,
        #[arg(long)]
        query: String,
        #[arg(long)]
        chat_pk: Option<i64>,
        #[arg(long, default_value_t = 180)]
        limit: u32,
        #[arg(long)]
        after_timestamp: Option<i64>,
        #[arg(long)]
        after_pk: Option<i64>,
    },
    Catalog {
        #[arg(long)]
        source: PathBuf,
    },
    Attachments {
        #[arg(long)]
        catalog: PathBuf,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long)]
        after_id: Option<i64>,
        #[arg(long)]
        kind: Option<AttachmentKind>,
        #[arg(long)]
        search: Option<String>,
    },
    Mark {
        #[arg(long)]
        catalog: PathBuf,
        #[arg(long)]
        path: String,
        #[arg(long, conflicts_with = "unmark")]
        mark: bool,
        #[arg(long, conflicts_with = "mark")]
        unmark: bool,
    },
    Stats {
        #[arg(long)]
        catalog: PathBuf,
    },
    Serve {
        #[arg(long)]
        source: PathBuf,
        #[arg(long)]
        reuse_session: bool,
    },
    Slim {
        #[arg(long)]
        source: PathBuf,
        #[arg(long)]
        catalog: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long)]
        full_crc: bool,
        #[arg(long)]
        link_duplicates: bool,
        #[arg(long)]
        allow_corrupt_line_square_rebuild: bool,
    },
    HashDuplicates {
        #[arg(long)]
        source: PathBuf,
        #[arg(long)]
        catalog: PathBuf,
    },
    Duplicates {
        #[arg(long)]
        catalog: PathBuf,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long)]
        after_reclaimable_bytes: Option<u64>,
        #[arg(long)]
        after_sha256: Option<String>,
    },
    DuplicateMembers {
        #[arg(long)]
        catalog: PathBuf,
        #[arg(long)]
        sha256: String,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long)]
        after_id: Option<i64>,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Inspect { source } => print_json(&inspect_source(&source)?)?,
        Command::Chats {
            source,
            limit,
            after_updated,
            after_pk,
        } => {
            let prepared = prepare_source(&source, &cli.work_dir)?;
            let database = LineDatabase::open(&prepared.database_path)?;
            let square_database = prepared
                .square_database_path
                .as_deref()
                .map(LineSquareDatabase::open)
                .transpose()?;
            let unified_group_database = prepared
                .unified_group_database_path
                .as_deref()
                .map(UnifiedGroupDatabase::open)
                .transpose()?;
            let cursor = paired_cursor(after_updated, after_pk, |last_updated, pk| ChatCursor {
                last_updated,
                source: "line".to_string(),
                pk,
            })?;
            let mut page = database.list_chats(cursor, limit)?;
            database.enrich_chat_titles(
                &mut page.items,
                unified_group_database.as_ref(),
                square_database.as_ref(),
            )?;
            print_json(&page)?;
        }
        Command::Messages {
            source,
            chat_pk,
            limit,
            after_timestamp,
            after_pk,
        } => {
            let prepared = prepare_source(&source, &cli.work_dir)?;
            let database = LineDatabase::open(&prepared.database_path)?;
            let cursor = paired_cursor(after_timestamp, after_pk, |timestamp, pk| MessageCursor {
                timestamp,
                pk,
            })?;
            print_json(&database.list_messages_for_account(
                chat_pk,
                cursor,
                limit,
                prepared.account_id.as_deref(),
            )?)?;
        }
        Command::Search {
            source,
            query,
            chat_pk,
            limit,
            after_timestamp,
            after_pk,
        } => {
            let prepared = prepare_source(&source, &cli.work_dir)?;
            let database = LineDatabase::open(&prepared.database_path)?;
            let cursor = paired_cursor(after_timestamp, after_pk, |timestamp, pk| MessageCursor {
                timestamp,
                pk,
            })?;
            print_json(&database.search_messages_for_account(
                &query,
                chat_pk,
                cursor,
                limit,
                prepared.account_id.as_deref(),
            )?)?;
        }
        Command::Catalog { source } => {
            let report = inspect_source(&source)?;
            let catalog_path = cli.work_dir.join("catalog.sqlite");
            let mut catalog = Catalog::open(&catalog_path)?;
            catalog.scan_source(&source, report.kind, |progress| {
                eprintln!(
                    "scanned {} files, {} bytes, {} attachments",
                    progress.files, progress.bytes, progress.attachments
                );
            })?;
            let prepared = prepare_source(&source, &cli.work_dir)?;
            let database = LineDatabase::open(&prepared.database_path)?;
            let square_database = prepared
                .square_database_path
                .as_deref()
                .map(LineSquareDatabase::open)
                .transpose()?;
            let unified_group_database = prepared
                .unified_group_database_path
                .as_deref()
                .map(UnifiedGroupDatabase::open)
                .transpose()?;
            catalog.index_attachment_contexts(
                &database,
                square_database.as_ref(),
                unified_group_database.as_ref(),
                |progress| {
                    eprintln!(
                        "correlated {}/{} attachments",
                        progress.processed_files, progress.total_files
                    );
                },
            )?;
            let stats = catalog.stats()?;
            print_json(&stats)?;
        }
        Command::Attachments {
            catalog,
            limit,
            after_id,
            kind,
            search,
        } => {
            let catalog = Catalog::open(&catalog)?;
            let cursor = after_id.map(|id| AttachmentCursor { id });
            print_json(&catalog.list_attachments(cursor, limit, kind, search.as_deref())?)?;
        }
        Command::Mark {
            catalog,
            path,
            mark,
            unmark,
        } => {
            if mark == unmark {
                anyhow::bail!("pass exactly one of --mark or --unmark");
            }
            let catalog = Catalog::open(&catalog)?;
            catalog.set_marked(&path, mark)?;
            print_json(&catalog.stats()?)?;
        }
        Command::Stats { catalog } => {
            print_json(&Catalog::open(&catalog)?.stats()?)?;
        }
        Command::Serve {
            source,
            reuse_session,
        } => {
            let stdout = std::io::stdout();
            let mut output = BufWriter::new(stdout.lock());
            let mut session = if reuse_session {
                NativeSession::open_reporting_reusing_catalog(&source, &cli.work_dir, &mut output)?
            } else {
                NativeSession::open_reporting(&source, &cli.work_dir, &mut output)?
            };
            let stdin = std::io::stdin();
            serve(&mut session, &mut BufReader::new(stdin.lock()), &mut output)?;
        }
        Command::Slim {
            source,
            catalog,
            output,
            full_crc,
            link_duplicates,
            allow_corrupt_line_square_rebuild,
        } => {
            let catalog = Catalog::open(&catalog)?;
            let report = build_candidate_with_options(
                &source,
                &output,
                &catalog,
                CandidateOptions {
                    full_crc,
                    link_duplicates,
                    allow_corrupt_line_square_rebuild,
                },
                |progress| {
                    if progress.processed_entries % 64 == 0
                        || progress.processed_entries == progress.total_entries
                    {
                        eprintln!(
                            "processed {}/{} entries, {}/{} bytes",
                            progress.processed_entries,
                            progress.total_entries,
                            progress.processed_bytes,
                            progress.total_bytes
                        );
                    }
                    Ok(())
                },
            )?;
            print_json(&report)?;
        }
        Command::HashDuplicates { source, catalog } => {
            let report = inspect_source(&source)?;
            let catalog = Catalog::open(&catalog)?;
            let result = catalog.hash_duplicate_candidates(&source, report.kind, |progress| {
                if progress.processed_files % 64 == 0
                    || progress.processed_files == progress.candidate_files
                {
                    eprintln!(
                        "hashed {}/{} files, {}/{} bytes",
                        progress.processed_files,
                        progress.candidate_files,
                        progress.processed_bytes,
                        progress.total_bytes
                    );
                }
                Ok(())
            })?;
            print_json(&result)?;
        }
        Command::Duplicates {
            catalog,
            limit,
            after_reclaimable_bytes,
            after_sha256,
        } => {
            let cursor = match (after_reclaimable_bytes, after_sha256) {
                (None, None) => None,
                (Some(reclaimable_bytes), Some(sha256)) => Some(DuplicateGroupCursor {
                    reclaimable_bytes,
                    sha256,
                }),
                _ => anyhow::bail!("both duplicate cursor components must be provided together"),
            };
            print_json(&Catalog::open(&catalog)?.list_duplicate_groups(cursor, limit)?)?;
        }
        Command::DuplicateMembers {
            catalog,
            sha256,
            limit,
            after_id,
        } => {
            let cursor = after_id.map(|id| AttachmentCursor { id });
            print_json(&Catalog::open(&catalog)?.list_duplicate_members(&sha256, cursor, limit)?)?;
        }
    }
    Ok(())
}

fn paired_cursor<T>(
    left: Option<i64>,
    right: Option<i64>,
    constructor: impl FnOnce(i64, i64) -> T,
) -> Result<Option<T>> {
    match (left, right) {
        (None, None) => Ok(None),
        (Some(left), Some(right)) => Ok(Some(constructor(left, right))),
        _ => anyhow::bail!("both cursor components must be provided together"),
    }
}

fn print_json(value: &impl Serialize) -> Result<()> {
    serde_json::to_writer_pretty(std::io::stdout().lock(), value)?;
    println!();
    Ok(())
}
