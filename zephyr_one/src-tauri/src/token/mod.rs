//! Local token vault for mutual backup with Zephyr main / Zephyr Agent.
//! Persists under app data dir as agent-tokens-one.json (version 2 compatible).

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRecord {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub token: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_used_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TokenFile {
    version: u32,
    tokens: Vec<TokenRecord>,
}

#[derive(Default)]
pub struct TokenState {
    path: Mutex<Option<PathBuf>>,
    cache: Mutex<Vec<TokenRecord>>,
}

impl TokenState {
    pub fn set_path(&self, path: PathBuf) {
        *self.path.lock() = Some(path);
        let _ = self.reload();
    }

    fn file_path(&self) -> Option<PathBuf> {
        self.path.lock().clone()
    }

    pub fn reload(&self) -> Result<(), String> {
        let Some(path) = self.file_path() else {
            return Ok(());
        };
        if !path.exists() {
            *self.cache.lock() = Vec::new();
            return Ok(());
        }
        let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let parsed: TokenFile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        *self.cache.lock() = parsed.tokens;
        Ok(())
    }

    fn persist(&self) -> Result<(), String> {
        let Some(path) = self.file_path() else {
            return Err("token path not configured".into());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tokens = self.cache.lock().clone();
        let file = TokenFile {
            version: 2,
            tokens,
        };
        let raw = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        fs::write(path, raw).map_err(|e| e.to_string())
    }

    pub fn list(&self) -> Vec<TokenRecord> {
        let mut items = self.cache.lock().clone();
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        items
    }

    pub fn add(&self, token: String, name: String, owner_id: Option<String>) -> Result<TokenRecord, String> {
        let token = token.trim().to_string();
        if token.is_empty() {
            return Err("empty token".into());
        }
        let now = now_ms();
        let mut cache = self.cache.lock();
        if let Some(existing) = cache.iter_mut().find(|t| t.token == token) {
            existing.name = name;
            existing.updated_at = now;
            let out = existing.clone();
            drop(cache);
            self.persist()?;
            return Ok(out);
        }
        let record = TokenRecord {
            id: format!("tok_{}", Uuid::new_v4().simple()),
            owner_id: owner_id.unwrap_or_else(|| "local".into()),
            name: if name.trim().is_empty() {
                "Zephyr One".into()
            } else {
                name.chars().take(80).collect()
            },
            token,
            created_at: now,
            updated_at: now,
            last_used_at: None,
        };
        cache.insert(0, record.clone());
        drop(cache);
        self.persist()?;
        Ok(record)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        {
            let mut cache = self.cache.lock();
            cache.retain(|t| t.id != id);
        }
        self.persist()
    }

    pub fn export_json(&self) -> Result<String, String> {
        let file = TokenFile {
            version: 2,
            tokens: self.list(),
        };
        serde_json::to_string_pretty(&serde_json::json!({
            "version": file.version,
            "source": "zephyr-one",
            "exportedAt": now_ms(),
            "tokens": file.tokens,
        }))
        .map_err(|e| e.to_string())
    }

    pub fn import_json(&self, raw: &str) -> Result<usize, String> {
        let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        let items: Vec<TokenRecord> = if let Some(arr) = value.as_array() {
            serde_json::from_value(serde_json::Value::Array(arr.clone())).map_err(|e| e.to_string())?
        } else if let Some(tokens) = value.get("tokens") {
            serde_json::from_value(tokens.clone()).map_err(|e| e.to_string())?
        } else if value.get("token").is_some() {
            let one: TokenRecord = serde_json::from_value(value).map_err(|e| e.to_string())?;
            vec![one]
        } else {
            return Err("invalid token backup JSON".into());
        };
        let mut n = 0usize;
        for item in items {
            if item.token.trim().is_empty() {
                continue;
            }
            self.add(item.token, item.name, Some(item.owner_id))?;
            n += 1;
        }
        Ok(n)
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
