//! `~/.ssh/config`, read for exactly as much as connecting needs.
//!
//! Parsing is delegated to `ssh2-config` rather than hand-rolled: `Host`
//! patterns are glob-matched, later blocks contribute parameters the first
//! block did not set, and `Include` and `Match` exist — a regex over the file
//! would get the easy cases right and the interesting ones wrong. The parse is
//! deliberately *lenient* (`ALLOW_UNKNOWN_FIELDS | ALLOW_UNSUPPORTED_FIELDS`):
//! the crate does not model `Match`, and a config with one `Match` block in it
//! is a config where every other host should still be reachable.
//!
//! What this module does **not** do is act on `ProxyJump`. It reports it, and
//! [`crate::remote::remote_connect`] turns that into a legible "not supported
//! yet" — a jump host silently ignored would connect to the wrong machine, or
//! hang against one that is not routable.

use std::io::BufRead;
use std::path::PathBuf;

use serde::Serialize;
use ssh2_config::{ParseRule, SshConfig};

/// One alias as the palette lists it. `hostname` is what the alias resolves
/// to, shown beside it so two aliases for the same box are distinguishable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHost {
    pub alias: String,
    pub hostname: String,
    pub user: String,
    pub port: u16,
    /// Present when the alias needs a jump host. Listed, but refused at
    /// connect time — see the module comment.
    pub proxy_jump: Option<String>,
}

/// Everything a connection needs, with OpenSSH's defaults already applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedHost {
    pub alias: String,
    pub hostname: String,
    pub user: String,
    pub port: u16,
    pub proxy_jump: Option<String>,
}

pub fn ssh_config_path() -> Option<PathBuf> {
    home().map(|h| h.join(".ssh").join("config"))
}

pub fn known_hosts_path() -> Option<PathBuf> {
    home().map(|h| h.join(".ssh").join("known_hosts"))
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// The login name to use when the config does not name one — the same fallback
/// OpenSSH makes, which is the local user.
fn default_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_else(|_| "root".to_string())
}

fn parse(reader: &mut impl BufRead) -> Result<SshConfig, String> {
    SshConfig::default()
        .parse(
            reader,
            ParseRule::ALLOW_UNKNOWN_FIELDS | ParseRule::ALLOW_UNSUPPORTED_FIELDS,
        )
        .map_err(|e| format!("Could not parse ~/.ssh/config: {e}"))
}

/// Every alias worth offering, in file order.
///
/// Pattern blocks (`Host *`, `Host web-?`) and negations are skipped: those are
/// *defaults* applied to other hosts, not machines anyone can pick from a list.
/// The one thing that would make a wildcard connectable is the user typing a
/// concrete name, and this slice has no free-text entry.
pub fn host_aliases(reader: &mut impl BufRead) -> Result<Vec<RemoteHost>, String> {
    let config = parse(reader)?;
    let mut seen: Vec<String> = Vec::new();
    for host in config.get_hosts() {
        for clause in &host.pattern {
            if clause.negated || clause.pattern.contains(['*', '?']) {
                continue;
            }
            if !seen.iter().any(|a| a == &clause.pattern) {
                seen.push(clause.pattern.clone());
            }
        }
    }
    Ok(seen
        .into_iter()
        .map(|alias| {
            let params = config.query(&alias);
            RemoteHost {
                hostname: params.host_name.clone().unwrap_or_else(|| alias.clone()),
                user: params.user.clone().unwrap_or_else(default_user),
                port: params.port.unwrap_or(22),
                proxy_jump: params.proxy_jump.as_ref().map(|j| j.join(",")),
                alias,
            }
        })
        .collect())
}

/// Resolve one alias. An alias absent from the config resolves to itself —
/// that is what `ssh some.host.example` does, and refusing it here would make
/// the config file mandatory for no reason.
pub fn resolve(reader: &mut impl BufRead, alias: &str) -> Result<ResolvedHost, String> {
    let config = parse(reader)?;
    let params = config.query(alias);
    Ok(ResolvedHost {
        hostname: params.host_name.clone().unwrap_or_else(|| alias.to_string()),
        user: params.user.clone().unwrap_or_else(default_user),
        port: params.port.unwrap_or(22),
        proxy_jump: params.proxy_jump.as_ref().map(|j| j.join(",")),
        alias: alias.to_string(),
    })
}

/// Read the user's config, or an empty one when there is no file. A machine
/// with no `~/.ssh/config` has no aliases, which is an empty list rather than
/// an error the palette has to explain.
pub fn read_user_config() -> Result<String, String> {
    let Some(path) = ssh_config_path() else {
        return Ok(String::new());
    };
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
Host cachy-ts
    HostName cachy-homeserver
    User matias
    Port 2222

Host *
    ServerAliveInterval 30

Host bastion-child
    HostName 10.0.0.5
    ProxyJump bastion
";

    fn cursor(s: &str) -> std::io::Cursor<&[u8]> {
        std::io::Cursor::new(s.as_bytes())
    }

    #[test]
    fn lists_concrete_aliases_and_skips_the_defaults_block() {
        let hosts = host_aliases(&mut cursor(SAMPLE)).unwrap();
        let names: Vec<&str> = hosts.iter().map(|h| h.alias.as_str()).collect();
        // `Host *` is a defaults block, not a machine anyone can pick.
        assert_eq!(names, vec!["cachy-ts", "bastion-child"]);

        let cachy = &hosts[0];
        assert_eq!(cachy.hostname, "cachy-homeserver");
        assert_eq!(cachy.user, "matias");
        assert_eq!(cachy.port, 2222);
        assert!(cachy.proxy_jump.is_none());
    }

    /// A jump host is *listed* — hiding it would make the alias look like it
    /// does not exist — and refused later, with a reason.
    #[test]
    fn reports_proxy_jump_rather_than_hiding_the_alias() {
        let hosts = host_aliases(&mut cursor(SAMPLE)).unwrap();
        let child = hosts.iter().find(|h| h.alias == "bastion-child").unwrap();
        assert_eq!(child.proxy_jump.as_deref(), Some("bastion"));
    }

    #[test]
    fn unknown_alias_resolves_to_itself_on_the_default_port() {
        let r = resolve(&mut cursor(SAMPLE), "box.example.com").unwrap();
        assert_eq!(r.hostname, "box.example.com");
        assert_eq!(r.port, 22);
    }

    /// `Match` is not a field `ssh2-config` models. A config containing one
    /// must still yield every other host rather than failing the whole parse.
    #[test]
    fn tolerates_blocks_the_parser_does_not_model() {
        let src = "Match host cachy-ts\n    User other\n\nHost plain\n    HostName 10.0.0.9\n";
        let hosts = host_aliases(&mut cursor(src)).unwrap();
        assert!(hosts.iter().any(|h| h.alias == "plain"));
    }
}
