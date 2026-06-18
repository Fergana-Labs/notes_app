//! Hybrid Logical Clock — byte-for-byte the same rules as the mobile
//! clock.ts so ops authored on either side order identically. Persisted in
//! `sync_meta` (hlc_wall, hlc_counter).

use crate::error::Result;
use crate::sync::oplog::{get_meta, set_meta};
use chrono::Utc;
use rusqlite::Connection;
use std::cmp::Ordering;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hlc {
    pub wall: i64,
    pub counter: i64,
}

fn read_clock(conn: &Connection) -> Result<Hlc> {
    let wall = get_meta(conn, "hlc_wall")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let counter = get_meta(conn, "hlc_counter")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    Ok(Hlc { wall, counter })
}

fn write_clock(conn: &Connection, hlc: Hlc) -> Result<()> {
    set_meta(conn, "hlc_wall", &hlc.wall.to_string())?;
    set_meta(conn, "hlc_counter", &hlc.counter.to_string())?;
    Ok(())
}

/// Advance the clock for a locally-originated event and return the stamp.
pub fn tick_local(conn: &Connection) -> Result<Hlc> {
    let now = Utc::now().timestamp_millis();
    let cur = read_clock(conn)?;
    let next = if now > cur.wall {
        Hlc { wall: now, counter: 0 }
    } else {
        Hlc { wall: cur.wall, counter: cur.counter + 1 }
    };
    write_clock(conn, next)?;
    Ok(next)
}

/// Merge a received remote stamp into the local clock (HLC receive rule).
pub fn tick_remote(conn: &Connection, remote: Hlc) -> Result<()> {
    let now = Utc::now().timestamp_millis();
    let cur = read_clock(conn)?;
    let wall = cur.wall.max(remote.wall).max(now);
    let counter = if wall == cur.wall && wall == remote.wall {
        cur.counter.max(remote.counter) + 1
    } else if wall == cur.wall {
        cur.counter + 1
    } else if wall == remote.wall {
        remote.counter + 1
    } else {
        0
    };
    write_clock(conn, Hlc { wall, counter })?;
    Ok(())
}

/// Total order over stamps: wall, then counter, then origin string.
pub fn compare(a_wall: i64, a_counter: i64, a_origin: &str, b_wall: i64, b_counter: i64, b_origin: &str) -> Ordering {
    a_wall
        .cmp(&b_wall)
        .then(a_counter.cmp(&b_counter))
        .then(a_origin.cmp(b_origin))
}
