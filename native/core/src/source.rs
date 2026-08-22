use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;
use zip::ZipArchive;

use crate::cancel::check_cancelled;

const STAGE_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const STAGE_PROGRESS_STEP_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Directory,
    Sqlite,
    ImazingArchive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceReport {
    pub source_path: String,
    pub kind: SourceKind,
    pub source_bytes: u64,
    pub database_path: String,
    pub database_bytes: u64,
    pub wal_present: bool,
    pub shm_present: bool,
    pub requires_staging: bool,
}

#[derive(Debug, Clone)]
pub struct PreparedSource {
    pub report: SourceReport,
    pub original_path: PathBuf,
    pub account_id: Option<String>,
    pub database_path: PathBuf,
    pub square_database_path: Option<PathBuf>,
    pub unified_group_database_path: Option<PathBuf>,
    pub staging_directory: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PreparePhase {
    ReadingArchiveIndex,
    StagingDatabases,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareProgress {
    pub phase: PreparePhase,
    pub entry: Option<String>,
    pub staged_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone)]
struct ArchiveDatabaseCandidate {
    name: String,
    bytes: u64,
}

#[derive(Debug, Clone)]
struct PlannedStagingEntry {
    index: usize,
    name: String,
    destination: PathBuf,
    bytes: u64,
}

pub fn inspect_source(source: &Path) -> Result<SourceReport> {
    let source = source
        .canonicalize()
        .with_context(|| format!("source does not exist: {}", source.display()))?;
    let metadata = fs::metadata(&source)?;
    if metadata.is_dir() {
        let database = find_directory_database(&source)?;
        let database_metadata = fs::metadata(&database)?;
        let wal = sibling_with_suffix(&database, "-wal");
        let shm = sibling_with_suffix(&database, "-shm");
        return Ok(SourceReport {
            source_path: source.display().to_string(),
            kind: SourceKind::Directory,
            source_bytes: 0,
            database_path: database
                .strip_prefix(&source)
                .unwrap_or(&database)
                .to_string_lossy()
                .replace('\\', "/"),
            database_bytes: database_metadata.len(),
            wal_present: wal.is_file(),
            shm_present: shm.is_file(),
            requires_staging: false,
        });
    }

    if is_imazing_archive(&source) {
        let mut archive = open_archive(&source)?;
        return archive_report(&source, metadata.len(), &mut archive);
    }

    if source
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("Line.sqlite"))
    {
        let wal = sibling_with_suffix(&source, "-wal");
        let shm = sibling_with_suffix(&source, "-shm");
        return Ok(SourceReport {
            source_path: source.display().to_string(),
            kind: SourceKind::Sqlite,
            source_bytes: metadata.len(),
            database_path: source.display().to_string(),
            database_bytes: metadata.len(),
            wal_present: wal.is_file(),
            shm_present: shm.is_file(),
            requires_staging: false,
        });
    }

    bail!(
        "source must be a LINE backup directory, Line.sqlite, or .imazingapp: {}",
        source.display()
    )
}

pub fn prepare_source(source: &Path, work_dir: &Path) -> Result<PreparedSource> {
    prepare_source_reporting(source, work_dir, |_| {})
}

pub fn prepare_source_reporting<F>(
    source: &Path,
    work_dir: &Path,
    mut on_progress: F,
) -> Result<PreparedSource>
where
    F: FnMut(&PrepareProgress),
{
    check_cancelled()?;
    if is_imazing_archive(source) && source.is_file() {
        return prepare_archive_source(source, work_dir, &mut on_progress);
    }
    let report = inspect_source(source)?;
    let original_path = PathBuf::from(&report.source_path);
    let account_id = account_id_from_database_path(&report.database_path);
    match report.kind {
        SourceKind::Directory => {
            let database_path = original_path.join(Path::new(&report.database_path));
            let square_database_path = sibling_database(&database_path, "LineSquare.sqlite");
            let unified_group_database_path =
                sibling_database(&database_path, "UnifiedGroup.sqlite");
            Ok(PreparedSource {
                report,
                original_path,
                account_id,
                database_path,
                square_database_path,
                unified_group_database_path,
                staging_directory: None,
            })
        }
        SourceKind::Sqlite => Ok(PreparedSource {
            report,
            database_path: original_path.clone(),
            original_path,
            account_id,
            square_database_path: None,
            unified_group_database_path: None,
            staging_directory: None,
        }),
        SourceKind::ImazingArchive => {
            prepare_archive_source(&original_path, work_dir, &mut on_progress)
        }
    }
}

fn prepare_archive_source<F>(
    source: &Path,
    work_dir: &Path,
    on_progress: &mut F,
) -> Result<PreparedSource>
where
    F: FnMut(&PrepareProgress),
{
    check_cancelled()?;
    let source = source
        .canonicalize()
        .with_context(|| format!("source does not exist: {}", source.display()))?;
    let metadata = fs::metadata(&source)?;
    on_progress(&PrepareProgress {
        phase: PreparePhase::ReadingArchiveIndex,
        entry: None,
        staged_bytes: 0,
        total_bytes: 0,
    });
    let mut archive = open_archive(&source)?;
    let report = archive_report(&source, metadata.len(), &mut archive)?;
    let account_id = account_id_from_database_path(&report.database_path);
    let staging_directory = work_dir
        .join("staging")
        .join(staging_fingerprint(&source, &metadata));
    fs::create_dir_all(&staging_directory)?;
    let (database_path, square_database_path, unified_group_database_path) =
        stage_archive_databases(&mut archive, &report, &staging_directory, on_progress)?;
    Ok(PreparedSource {
        report,
        original_path: source,
        account_id,
        database_path,
        square_database_path,
        unified_group_database_path,
        staging_directory: Some(staging_directory),
    })
}

fn account_id_from_database_path(path: &str) -> Option<String> {
    path.replace('\\', "/")
        .split('/')
        .find_map(|segment| segment.strip_prefix("P_"))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn is_imazing_archive(path: &Path) -> bool {
    path.extension().is_some_and(|extension| {
        extension
            .to_string_lossy()
            .eq_ignore_ascii_case("imazingapp")
    })
}

fn staging_fingerprint(path: &Path, metadata: &fs::Metadata) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified_ns(metadata).to_le_bytes());
    format!("{:x}", hasher.finalize())
}

fn modified_ns(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|value: SystemTime| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| i64::try_from(value.as_nanos()).ok())
        .unwrap_or(0)
}

fn sibling_with_suffix(database: &Path, suffix: &str) -> PathBuf {
    let mut name = database.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    database.with_file_name(name)
}

fn sibling_database(database: &Path, filename: &str) -> Option<PathBuf> {
    let candidate = database.with_file_name(filename);
    candidate.is_file().then_some(candidate)
}

fn database_priority(path: &str) -> Option<u8> {
    let normalized = path.replace('\\', "/");
    if !normalized
        .to_ascii_lowercase()
        .ends_with("/messages/line.sqlite")
        && !normalized.eq_ignore_ascii_case("Line.sqlite")
    {
        return None;
    }
    if normalized.contains("/PrivateStore/P_") {
        Some(0)
    } else if normalized.contains("group.com.linecorp.line") {
        Some(1)
    } else {
        Some(2)
    }
}

fn find_directory_database(root: &Path) -> Result<PathBuf> {
    let mut best: Option<(u8, PathBuf)> = None;
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.file_type().is_file()
            || !entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("Line.sqlite")
        {
            continue;
        }
        let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
        let normalized = relative.to_string_lossy().replace('\\', "/");
        let Some(priority) = database_priority(&normalized) else {
            continue;
        };
        if best
            .as_ref()
            .is_none_or(|(best_priority, _)| priority < *best_priority)
        {
            best = Some((priority, entry.into_path()));
            if priority == 0 {
                break;
            }
        }
    }
    best.map(|(_, path)| path)
        .context("backup does not contain Messages/Line.sqlite")
}

fn open_archive(source: &Path) -> Result<ZipArchive<File>> {
    let file = File::open(source)?;
    ZipArchive::new(file).context("cannot open .imazingapp as ZIP")
}

fn archive_report(
    source: &Path,
    source_bytes: u64,
    archive: &mut ZipArchive<File>,
) -> Result<SourceReport> {
    let candidate = find_archive_database(archive)?;
    let wal_present = find_archive_entry(archive, &format!("{}-wal", candidate.name)).is_some();
    let shm_present = find_archive_entry(archive, &format!("{}-shm", candidate.name)).is_some();
    Ok(SourceReport {
        source_path: source.display().to_string(),
        kind: SourceKind::ImazingArchive,
        source_bytes,
        database_path: candidate.name,
        database_bytes: candidate.bytes,
        wal_present,
        shm_present,
        requires_staging: true,
    })
}

fn find_archive_database(archive: &mut ZipArchive<File>) -> Result<ArchiveDatabaseCandidate> {
    let mut best: Option<(u8, usize, String)> = None;
    for (index, name) in archive.file_names().enumerate() {
        let Some(priority) = database_priority(name) else {
            continue;
        };
        if best
            .as_ref()
            .is_none_or(|(current, _, _)| priority < *current)
        {
            best = Some((priority, index, name.to_string()));
            if priority == 0 {
                break;
            }
        }
    }
    let (_, index, name) = best.context(".imazingapp does not contain Messages/Line.sqlite")?;
    let bytes = archive.by_index(index)?.size();
    Ok(ArchiveDatabaseCandidate { name, bytes })
}

fn stage_archive_databases<F>(
    archive: &mut ZipArchive<File>,
    report: &SourceReport,
    staging_directory: &Path,
    on_progress: &mut F,
) -> Result<(PathBuf, Option<PathBuf>, Option<PathBuf>)>
where
    F: FnMut(&PrepareProgress),
{
    let database_name = report.database_path.clone();
    let square_name = archive_sibling_name(&database_name, "LineSquare.sqlite");
    let unified_group_name = archive_sibling_name(&database_name, "UnifiedGroup.sqlite");
    let mut wanted = vec![
        database_name.clone(),
        format!("{database_name}-wal"),
        format!("{database_name}-shm"),
    ];
    if find_archive_entry(archive, &square_name).is_some() {
        wanted.extend([
            square_name.clone(),
            format!("{square_name}-wal"),
            format!("{square_name}-shm"),
        ]);
    }
    if find_archive_entry(archive, &unified_group_name).is_some() {
        wanted.extend([
            unified_group_name.clone(),
            format!("{unified_group_name}-wal"),
            format!("{unified_group_name}-shm"),
        ]);
    }

    let mut planned = Vec::new();
    for name in wanted {
        let Some(index) = find_archive_entry(archive, &name) else {
            continue;
        };
        let filename = Path::new(&name)
            .file_name()
            .context("invalid database entry path")?;
        let destination = staging_directory.join(filename);
        let bytes = archive.by_index(index)?.size();
        planned.push(PlannedStagingEntry {
            index,
            name,
            destination,
            bytes,
        });
    }

    let total_bytes = planned
        .iter()
        .filter(|entry| !staged_file_is_current(&entry.destination, entry.bytes))
        .map(|entry| entry.bytes)
        .sum();
    let mut staged_bytes = 0_u64;
    on_progress(&PrepareProgress {
        phase: PreparePhase::StagingDatabases,
        entry: None,
        staged_bytes,
        total_bytes,
    });

    let mut staged_database = None;
    let mut staged_square_database = None;
    let mut staged_unified_group_database = None;
    for entry in planned {
        check_cancelled()?;
        if !staged_file_is_current(&entry.destination, entry.bytes) {
            let temporary = staging_partial_path(&entry.destination);
            let display = entry
                .destination
                .file_name()
                .map(|value| value.to_string_lossy().into_owned());
            let staging_result = (|| -> Result<()> {
                let mut source = archive.by_index(entry.index)?;
                let mut output = BufWriter::new(
                    File::create(&temporary)
                        .with_context(|| format!("cannot create {}", temporary.display()))?,
                );
                let mut reported_bytes = staged_bytes;
                copy_with_progress(&mut source, &mut output, |chunk| {
                    staged_bytes += chunk;
                    if staged_bytes - reported_bytes >= STAGE_PROGRESS_STEP_BYTES {
                        reported_bytes = staged_bytes;
                        on_progress(&PrepareProgress {
                            phase: PreparePhase::StagingDatabases,
                            entry: display.clone(),
                            staged_bytes,
                            total_bytes,
                        });
                    }
                })?;
                output.flush()?;
                Ok(())
            })();
            if let Err(error) = staging_result {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
            fs::rename(&temporary, &entry.destination)?;
            on_progress(&PrepareProgress {
                phase: PreparePhase::StagingDatabases,
                entry: display,
                staged_bytes,
                total_bytes,
            });
        }
        if entry.name == report.database_path {
            staged_database = Some(entry.destination);
        } else if entry.name == square_name {
            staged_square_database = Some(entry.destination);
        } else if entry.name == unified_group_name {
            staged_unified_group_database = Some(entry.destination);
        }
    }
    Ok((
        staged_database.context("failed to stage Line.sqlite from .imazingapp")?,
        staged_square_database,
        staged_unified_group_database,
    ))
}

fn staged_file_is_current(destination: &Path, expected_bytes: u64) -> bool {
    destination
        .metadata()
        .is_ok_and(|metadata| metadata.len() == expected_bytes)
}

fn staging_partial_path(destination: &Path) -> PathBuf {
    let mut name = destination.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    destination.with_file_name(name)
}

fn copy_with_progress<R: Read, W: Write, F: FnMut(u64)>(
    source: &mut R,
    output: &mut W,
    mut on_chunk: F,
) -> Result<u64> {
    let mut buffer = vec![0_u8; STAGE_CHUNK_BYTES];
    let mut copied = 0_u64;
    loop {
        check_cancelled()?;
        let read = source.read(&mut buffer)?;
        if read == 0 {
            return Ok(copied);
        }
        output.write_all(&buffer[..read])?;
        copied += read as u64;
        on_chunk(read as u64);
    }
}

fn archive_sibling_name(database_name: &str, filename: &str) -> String {
    database_name
        .rsplit_once('/')
        .map(|(parent, _)| format!("{parent}/{filename}"))
        .unwrap_or_else(|| filename.to_string())
}

fn find_archive_entry(archive: &ZipArchive<File>, wanted: &str) -> Option<usize> {
    archive.file_names().position(|name| name == wanted)
}
