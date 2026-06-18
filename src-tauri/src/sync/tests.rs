//! Pure-logic sync tests: capture (reconcile-diff) → apply, convergence, LWW,
//! and echo suppression. Two in-memory DBs stand in for desktop + phone; ops
//! move between them by hand (no relay/network). Run with `cargo test`.

use crate::db;
use crate::sync::{apply, oplog, reconcile};
use rusqlite::Connection;

fn make_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.execute_batch(db::SCHEMA).unwrap();
    crate::sync::apply_sync_schema(&conn).unwrap();
    conn
}

fn dev(conn: &Connection) -> String {
    oplog::device_id(conn).unwrap()
}

/// Capture A's pending ops and apply them to B. Returns ops applied.
fn flush(a: &mut Connection, b: &mut Connection) -> usize {
    let device = dev(a);
    reconcile::capture(a, &device).unwrap();
    let (ops, _max) = oplog::pending_ops(a, &device, 0, 1000).unwrap();
    let mut applied = 0;
    for op in &ops {
        if apply::apply_remote_op(b, op).unwrap() {
            applied += 1;
        }
    }
    applied
}

fn capture_ops(conn: &mut Connection) -> Vec<crate::sync::wire::Op> {
    let device = dev(conn);
    reconcile::capture(conn, &device).unwrap();
    oplog::pending_ops(conn, &device, 0, 1000).unwrap().0
}

fn apply_ops(conn: &mut Connection, ops: &[crate::sync::wire::Op]) {
    for op in ops {
        apply::apply_remote_op(conn, op).unwrap();
    }
}

#[test]
fn create_propagates_with_tags() {
    let mut a = make_db();
    let mut b = make_db();

    db::save_snapshot(
        &mut a,
        &[db::BlockInput {
            id: "N1".into(),
            content: "ship the relay #work".into(),
            position: 0,
            parent_id: None,
            heading: None,
            heading_level: None,
            tags: None,
            pinned_scopes: None,
            title: None,
        }],
        &[],
        "canvas",
    )
    .unwrap();

    assert!(flush(&mut a, &mut b) >= 1);

    let blocks = db::list_blocks(&b).unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].content, "ship the relay");
    assert_eq!(blocks[0].tags, vec!["work".to_string()]);
}

#[test]
fn capture_is_idempotent_and_suppresses_echo() {
    let mut a = make_db();
    let mut b = make_db();
    db::save_snapshot(
        &mut a,
        &[db::BlockInput {
            id: "N1".into(),
            content: "hello".into(),
            position: 0,
            parent_id: None,
            heading: None,
            heading_level: None,
            tags: None,
            pinned_scopes: None,
            title: None,
        }],
        &[],
        "canvas",
    )
    .unwrap();
    flush(&mut a, &mut b);

    // B applied A's op; a fresh capture on B must NOT re-emit it (shadow set on apply).
    let bdev = dev(&b);
    let emitted = reconcile::capture(&mut b, &bdev).unwrap();
    assert_eq!(emitted, 0, "applied remote change should not echo as a local op");

    // A second capture on A with no changes emits nothing.
    let adev = dev(&a);
    assert_eq!(reconcile::capture(&mut a, &adev).unwrap(), 0);
}

#[test]
fn concurrent_edits_converge_by_lww() {
    let mut a = make_db();
    let mut b = make_db();
    // Seed on A, propagate to B so both share the same baseline + row meta.
    db::save_snapshot(&mut a, &[edit("N1", "base")], &[], "canvas").unwrap();
    flush(&mut a, &mut b);

    // Concurrent edits, captured on each side BEFORE exchanging (true divergence).
    db::save_snapshot(&mut a, &[edit("N1", "from A")], &[], "canvas").unwrap();
    db::save_snapshot(&mut b, &[edit("N1", "from B")], &[], "canvas").unwrap();
    let a_ops = capture_ops(&mut a);
    let b_ops = capture_ops(&mut b);

    // Cross-apply: each side sees the other's edit and resolves by LWW.
    apply_ops(&mut b, &a_ops);
    apply_ops(&mut a, &b_ops);

    let ca = db::list_blocks(&a).unwrap()[0].content.clone();
    let cb = db::list_blocks(&b).unwrap()[0].content.clone();
    assert_eq!(ca, cb, "devices converge to the same content");
    assert!(ca == "from A" || ca == "from B");
}

fn edit(id: &str, content: &str) -> db::BlockInput {
    db::BlockInput {
        id: id.into(),
        content: content.into(),
        position: 0,
        parent_id: None,
        heading: None,
        heading_level: None,
        tags: None,
        pinned_scopes: None,
        title: None,
    }
}
