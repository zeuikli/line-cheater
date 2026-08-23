use std::io::Write;

use anyhow::Result;
use sha2::{Digest, Sha256};

use crate::model::{Chat, Message, MessageAttachment};

pub(crate) fn attachment_entry_name(source_path: &str) -> String {
    let digest = Sha256::digest(source_path.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let extension = std::path::Path::new(source_path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 12
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
        .unwrap_or_else(|| "bin".to_string());
    format!("attachments/{digest}.{extension}")
}

pub(crate) fn avatar_entry_name(avatar_url: &str, extension: &str) -> String {
    let digest = Sha256::digest(avatar_url.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("avatars/{digest}.{extension}")
}

pub(crate) fn write_html_start<W: Write>(writer: &mut W, chat: &Chat) -> Result<()> {
    write!(
        writer,
        "<!doctype html><html lang=\"zh-Hant\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src 'self' file: data: https://stickershop.line-scdn.net; media-src 'self' file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'\">\
         <title>{}</title><style>{}</style></head><body><header><p class=\"eyebrow\">LINE 討論串封存</p>\
         <h1>{}</h1><p class=\"summary\">{} · 共 {} 則訊息 · 完整內容由最早到最新排列</p></header>\
         <main aria-label=\"討論串內容\">",
        escape_html(&chat.title),
        EXPORT_STYLES,
        escape_html(&chat.title),
        escape_html(chat_kind_label(&chat.kind)),
        chat.message_count.max(0),
    )?;
    Ok(())
}

pub(crate) fn write_message<W: Write>(
    writer: &mut W,
    message: &Message,
    avatar_entry: Option<&str>,
) -> Result<()> {
    let system = is_system_message(message);
    let class = if system {
        "message system"
    } else if message.is_self {
        "message self"
    } else {
        "message"
    };
    let sender = if system {
        "系統"
    } else if message.is_self {
        "我"
    } else if message.sender_name.is_empty() {
        "未知使用者"
    } else {
        &message.sender_name
    };
    write!(
        writer,
        "<article class=\"{class}\" data-message-pk=\"{}\">",
        message.pk
    )?;
    if !system && !message.is_self {
        let initial = sender.chars().next().unwrap_or('?');
        write!(
            writer,
            "<span class=\"avatar\" aria-hidden=\"true\"><span>{}</span>{}</span>",
            escape_html(&initial.to_string()),
            avatar_entry.map_or_else(String::new, |entry| format!(
                "<img src=\"{}\" alt=\"\">",
                escape_html(entry)
            ))
        )?;
    }
    write!(
        writer,
        "<div class=\"bubble\"><div class=\"meta\">\
         <strong>{}</strong><time data-line-timestamp=\"{}\">{}</time></div>",
        escape_html(sender),
        message.timestamp,
        message.timestamp,
    )?;
    if message.text.is_empty() {
        write!(
            writer,
            "<p class=\"kind\">[{}]</p>",
            escape_html(content_label(message))
        )?;
    } else {
        write!(
            writer,
            "<p class=\"text\">{}</p>",
            escape_html(&message.text)
        )?;
    }
    if let Some(sticker_id) = legacy_sticker_id(message) {
        write!(
            writer,
            "<figure class=\"sticker\"><img loading=\"lazy\" src=\"https://stickershop.line-scdn.net/stickershop/v1/sticker/{sticker_id}/iPhone/sticker_animation@2x.png\" alt=\"LINE 貼圖 {sticker_id}\"></figure>"
        )?;
    } else if let (Some(latitude), Some(longitude)) = (message.latitude, message.longitude)
        && (latitude != 0.0 || longitude != 0.0)
    {
        write!(
            writer,
            "<p class=\"coordinates\">位置：{}, {}</p>",
            latitude, longitude
        )?;
    }
    write_attachment_previews(writer, message)?;
    write_attachment_list(writer, &message.attachments)?;
    writer.write_all(b"</div></article>")?;
    Ok(())
}

pub(crate) fn write_html_end<W: Write>(writer: &mut W) -> Result<()> {
    writer.write_all(
        r#"</main><footer>由 LINE Cheater 匯出。附件與頭像保存在同一個 ZIP 檔內。</footer>
<script>
for (const node of document.querySelectorAll('time[data-line-timestamp]')) {
  let value = Number(node.dataset.lineTimestamp);
  if (!Number.isFinite(value) || value === 0) { node.textContent = '時間不明'; continue; }
  if (Math.abs(value) < 100000000000) {
    if (value > -978307200 && value < 1200000000) value += 978307200;
    value *= 1000;
  }
  const date = new Date(value);
  node.textContent = Number.isNaN(date.valueOf()) ? '時間不明' : date.toLocaleString();
}
</script></body></html>"#
            .as_bytes(),
    )?;
    Ok(())
}

fn write_attachment_previews<W: Write>(writer: &mut W, message: &Message) -> Result<()> {
    let originals = message
        .attachments
        .iter()
        .filter(|attachment| attachment.kind.as_str() == "original")
        .collect::<Vec<_>>();
    let candidates = if originals.is_empty() {
        message.attachments.iter().collect::<Vec<_>>()
    } else {
        originals
    };
    if !is_image_content(message, &candidates) {
        return Ok(());
    }
    writer.write_all(b"<div class=\"media\">")?;
    for attachment in candidates.into_iter().take(12) {
        let entry = attachment_entry_name(&attachment.path);
        write!(
            writer,
            "<a href=\"{entry}\" target=\"_blank\"><img loading=\"lazy\" src=\"{entry}\" alt=\"{}\"></a>",
            escape_html(&file_name(&attachment.path))
        )?;
    }
    writer.write_all(b"</div>")?;
    Ok(())
}

fn write_attachment_list<W: Write>(
    writer: &mut W,
    attachments: &[MessageAttachment],
) -> Result<()> {
    if attachments.is_empty() {
        return Ok(());
    }
    writer.write_all(b"<ul class=\"attachments\">")?;
    for attachment in attachments {
        let entry = attachment_entry_name(&attachment.path);
        let kind = if attachment.kind.as_str() == "thumbnail" {
            "縮圖"
        } else {
            "原始附件"
        };
        write!(
            writer,
            "<li><a href=\"{entry}\" download>{}</a><span>{kind} · {}</span></li>",
            escape_html(&file_name(&attachment.path)),
            format_bytes(attachment.bytes)
        )?;
    }
    writer.write_all(b"</ul>")?;
    Ok(())
}

fn is_system_message(message: &Message) -> bool {
    legacy_sticker_id(message).is_none()
        && (matches!(message.content_type, Some(7 | 18 | 96 | 111))
            || (message.sender_pk.is_none()
                && message.send_status == Some(0)
                && message.id.is_empty()))
}

fn legacy_sticker_id(message: &Message) -> Option<u64> {
    (message.content_type == Some(7) && message.latitude == Some(0.0))
        .then_some(message.longitude?)
        .filter(|value| value.is_finite() && *value > 0.0 && value.fract() == 0.0)
        .and_then(|value| u64::try_from(value as i128).ok())
}

fn is_image_content(message: &Message, attachments: &[&MessageAttachment]) -> bool {
    matches!(message.content_type, Some(1 | 16 | 112))
        || attachments.iter().any(|attachment| {
            let lower = attachment.path.to_ascii_lowercase();
            [
                ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif", ".heic", ".thumb",
            ]
            .iter()
            .any(|extension| lower.ends_with(extension))
        })
}

fn content_label(message: &Message) -> &'static str {
    if legacy_sticker_id(message).is_some() {
        return "貼圖";
    }
    match message.content_type {
        Some(1 | 16 | 112) => "照片",
        Some(2 | 17) => "影片",
        Some(3) => "語音",
        Some(4 | 14) => "檔案",
        Some(5 | 101) => "貼圖",
        Some(7 | 18 | 96 | 111) => "系統訊息",
        Some(100) => "位置",
        Some(107) => "連結",
        _ => "附件",
    }
}

fn chat_kind_label(kind: &str) -> &'static str {
    match kind {
        "direct" => "個人聊天室",
        "group" => "群組聊天室",
        "community" => "社群",
        _ => "聊天室",
    }
}

fn file_name(path: &str) -> String {
    path.replace('\\', "/")
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("未命名附件")
        .to_string()
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = "KB";
    for candidate in ["KB", "MB", "GB", "TB"] {
        value /= 1024.0;
        unit = candidate;
        if value < 1024.0 {
            break;
        }
    }
    format!("{value:.1} {unit}")
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

const EXPORT_STYLES: &str = r#"
:root{color-scheme:light;--ink:#16211b;--muted:#64748b;--line:#dce3df;--accent:#14b8a6;--accent-strong:#0f766e;--self:#f0fdfa}
*{box-sizing:border-box}body{max-width:980px;margin:0 auto;padding:28px 18px 48px;color:var(--ink);background:#f3f5f4;font:16px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header,footer{padding:20px 22px;border:1px solid var(--line);border-radius:16px;background:#fff}header{position:sticky;z-index:2;top:0;margin-bottom:22px;box-shadow:0 8px 24px #17332d12}h1{margin:3px 0 5px;font-size:clamp(1.4rem,4vw,2.1rem)}.eyebrow,.summary,footer{margin:0;color:var(--muted)}.eyebrow{font-size:.72rem;font-weight:800;letter-spacing:.12em}.message{display:flex;gap:10px;margin:12px 4px}.message.self{justify-content:flex-end}.message.system{justify-content:center}.avatar{position:relative;display:grid;width:34px;height:34px;flex:0 0 34px;place-items:center;overflow:hidden;margin-top:4px;border-radius:50%;color:#fff;background:#94a3b8;font-size:.78rem;font-weight:800}.avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.bubble{width:min(780px,90%);padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:#fff}.self .bubble{border-color:#99f6e4;background:var(--self)}.system .bubble{width:min(680px,94%);border-style:dashed;color:var(--muted);background:#f8fafc}.meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px;color:#7b8794;font-size:.72rem}.meta strong{color:#475569}.text,.kind,.coordinates{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.text{color:#111827}.kind{color:#64748b}.sticker{width:min(180px,100%);margin:10px 0 0}.sticker img{display:block;width:100%;max-height:180px;object-fit:contain}.media{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:8px;margin-top:10px}.media a{display:block}.media img{display:block;width:100%;max-height:620px;border-radius:10px;object-fit:contain;background:#e8efec}.attachments{display:grid;gap:5px;margin:10px 0 0;padding:9px 0 0;list-style:none;border-top:1px solid var(--line);font-size:.82rem}.attachments li{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px}.attachments a{color:var(--accent-strong);font-weight:700;overflow-wrap:anywhere}.attachments span{color:var(--muted)}footer{margin-top:24px;text-align:center;font-size:.82rem}@media(max-width:560px){body{padding:10px 8px 28px}header{padding:15px;top:0}.bubble{width:96%}}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AttachmentKind;

    #[test]
    fn escapes_untrusted_chat_and_message_content() {
        let chat = Chat {
            pk: 7,
            source: "line".to_string(),
            id: "u1".to_string(),
            chat_type: 0,
            kind: "direct".to_string(),
            title: "Alice <script>".to_string(),
            title_source: "chat".to_string(),
            message_count: 1,
            human_message_count: 1,
            last_updated: 1,
            last_message: String::new(),
            planned_for_removal: false,
        };
        let message = Message {
            pk: 1,
            source: "line".to_string(),
            id: "m1".to_string(),
            chat_pk: 7,
            timestamp: 100,
            sender_pk: Some(1),
            sender_name: "<Alice>".to_string(),
            avatar_url: String::new(),
            is_self: false,
            send_status: Some(0),
            content_type: Some(1),
            message_type: "R".to_string(),
            text: "<img src=x onerror=alert(1)> & hello".to_string(),
            latitude: None,
            longitude: None,
            attachments: vec![MessageAttachment {
                path: "folder/photo.jpg".to_string(),
                bytes: 42,
                kind: AttachmentKind::Original,
            }],
        };
        let mut output = Vec::new();
        write_html_start(&mut output, &chat).unwrap();
        write_message(&mut output, &message, Some("avatars/alice.png")).unwrap();
        write_html_end(&mut output).unwrap();
        let html = String::from_utf8(output).unwrap();
        assert!(html.contains("Alice &lt;script&gt;"));
        assert!(html.contains("&lt;img src=x onerror=alert(1)&gt; &amp; hello"));
        assert!(!html.contains("<img src=x onerror"));
        assert!(html.contains(&attachment_entry_name("folder/photo.jpg")));
        assert!(html.contains("avatars/alice.png"));
        assert!(html.contains("class=\"avatar\""));
    }

    #[test]
    fn attachment_names_are_deterministic_and_ascii_safe() {
        let first = attachment_entry_name("資料夾/照片.JPG");
        assert_eq!(first, attachment_entry_name("資料夾/照片.JPG"));
        assert!(first.starts_with("attachments/"));
        assert!(first.ends_with(".jpg"));
        assert!(first.is_ascii());

        let avatar = avatar_entry_name("https://profile.line-scdn.net/alice", "png");
        assert_eq!(
            avatar,
            avatar_entry_name("https://profile.line-scdn.net/alice", "png")
        );
        assert!(avatar.starts_with("avatars/"));
        assert!(avatar.ends_with(".png"));
    }

    #[test]
    fn renders_legacy_stickers_without_system_or_location_labels() {
        let message = Message {
            pk: 1,
            source: "line".to_string(),
            id: String::new(),
            chat_pk: 7,
            timestamp: 100,
            sender_pk: Some(1),
            sender_name: "Mock Sender".to_string(),
            avatar_url: String::new(),
            is_self: false,
            send_status: Some(0),
            content_type: Some(7),
            message_type: "R".to_string(),
            text: String::new(),
            latitude: Some(0.0),
            longitude: Some(2131765.0),
            attachments: Vec::new(),
        };
        let mut output = Vec::new();
        write_message(&mut output, &message, None).unwrap();
        let html = String::from_utf8(output).unwrap();

        assert!(!is_system_message(&message));
        assert_eq!(content_label(&message), "貼圖");
        assert!(html.contains("Mock Sender"));
        assert!(html.contains(
            "https://stickershop.line-scdn.net/stickershop/v1/sticker/2131765/iPhone/sticker_animation@2x.png"
        ));
        assert!(!html.contains("位置："));
    }
}
