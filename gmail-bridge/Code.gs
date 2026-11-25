/**
 * ============================================================================
 * ApplyPilot Gmail bridge — Google Apps Script
 *
 * WHY THIS AND NOT AN EMAIL SERVICE:
 *
 * The usual way to get mail into an app is to buy a domain, point it at an
 * email service, and receive webhooks. That costs money every year, and
 * worse, mail from a brand-new domain lands in spam — so the replies you
 * send would quietly stop arriving.
 *
 * This runs inside your own Google account instead. It reads the mailbox
 * employers are already writing to, and sends replies from the same address
 * that applied, in the same thread. Nothing to buy, nothing to warm up, and
 * the deliverability of a ten-year-old Gmail account rather than a domain
 * registered last week.
 *
 * Apps Script is free: 20,000 outbound requests and 90 minutes of runtime a
 * day, against which this uses a few seconds every five minutes.
 *
 * SETUP — once, about three minutes:
 *   1. script.google.com -> New project
 *   2. Paste this whole file over whatever is there, and Save
 *   3. Project Settings (gear, left side) -> Script Properties -> add:
 *        APP_URL     your panel's address, e.g. https://yourapp.lovable.app
 *                    (no trailing slash, no /api on the end)
 *        ENGINE_KEY  the same value as the panel's ENGINE_API_KEY secret
 *   4. Back in the editor, pick `install` from the function dropdown and Run.
 *      Google asks for permission to read and send your mail: that is this
 *      script, running in your account. Approve it.
 *   5. Done. It runs every five minutes from now on.
 *
 * To check on it: Executions, in the left sidebar.
 * ============================================================================
 */

var PROPS = PropertiesService.getScriptProperties();

var ENDPOINT = '/api/public/email/ingest';

/** How far back to look on the very first run. */
var FIRST_RUN_DAYS = 7;

/** Messages per run. A cap keeps one bad run from timing out mid-mailbox. */
var MAX_PER_RUN = 60;

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/** Run this once. Creates the five-minute trigger and does a first sync. */
function install() {
  requireConfig();

  // Remove our own old triggers first, so running install twice does not
  // leave two copies racing each other through the same mailbox.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sync') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('sync').timeBased().everyMinutes(5).create();
  Logger.log('Trigger installed. Running a first sync now.');
  sync();
}

/** Run this to stop it. */
function uninstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sync') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Stopped.');
}

function requireConfig() {
  var url = PROPS.getProperty('APP_URL');
  var secret = PROPS.getProperty('ENGINE_KEY');
  if (!url || !secret) {
    throw new Error(
      'Missing configuration. Project Settings -> Script Properties needs ' +
      'APP_URL and ENGINE_KEY.');
  }
  return { url: url.replace(/\/+$/, ''), secret: secret };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function sync() {
  var cfg = requireConfig();

  // Apps Script can overlap runs if one is slow. Two runs reading the same
  // window would send the same reply twice, which is the one mistake here
  // that a human on the other end actually sees.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Another run is in progress; skipping.');
    return;
  }

  try {
    var pushed = pushInbound(cfg);
    var sent = sendApprovedReplies(cfg);
    Logger.log('Sent ' + pushed + ' message(s) to the panel, posted ' + sent + ' reply/replies.');
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

function pushInbound(cfg) {
  var cursor = Number(PROPS.getProperty('LAST_SEEN_MS') || 0);
  if (!cursor) {
    cursor = Date.now() - FIRST_RUN_DAYS * 86400000;
  }

  // Gmail's `after:` takes whole seconds and is inclusive, so step back a
  // minute and let the database reject the duplicates. Overlapping is safe —
  // message_id is unique — and a gap is not, because a missed interview
  // invitation is invisible.
  var afterSec = Math.floor((cursor - 60000) / 1000);
  var query = 'in:inbox -in:chats after:' + afterSec;

  var threads = GmailApp.search(query, 0, 100);
  var batch = [];
  var newest = cursor;

  for (var i = 0; i < threads.length && batch.length < MAX_PER_RUN; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length && batch.length < MAX_PER_RUN; j++) {
      var m = messages[j];
      var when = m.getDate().getTime();
      if (when <= cursor - 60000) continue;
      if (when > newest) newest = when;

      // Skip our own replies coming back around in the same thread.
      var from = m.getFrom();
      if (from.indexOf(Session.getActiveUser().getEmail()) !== -1) continue;

      batch.push({
        message_id: m.getId(),
        thread_id: threads[i].getId(),
        from_addr: parseAddress(from),
        to_addr: parseAddress(m.getTo()),
        subject: m.getSubject(),
        // 20k is generous for a recruiting email and keeps a newsletter with
        // an enormous HTML footer from blowing the request size.
        body: m.getPlainBody().slice(0, 20000),
        received_at: m.getDate().toISOString()
      });
    }
  }

  if (!batch.length) {
    post(cfg, ENDPOINT, { messages: [], heartbeat: true });
    return 0;
  }

  var res = post(cfg, ENDPOINT, { messages: batch });
  if (res.code >= 200 && res.code < 300) {
    // Only advance the cursor once the panel has the messages. If the request
    // failed, the next run re-reads the same window rather than skipping it.
    PROPS.setProperty('LAST_SEEN_MS', String(newest));
  } else {
    throw new Error('ingest endpoint returned ' + res.code + ': ' + res.body.slice(0, 300));
  }
  return batch.length;
}

/** "Sarah Chen <sarah@target.com>" -> "sarah@target.com" */
function parseAddress(raw) {
  if (!raw) return '';
  var m = String(raw).match(/<([^>]+)>/);
  return (m ? m[1] : String(raw)).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

function sendApprovedReplies(cfg) {
  var res = post(cfg, ENDPOINT, { action: 'pending_replies' });
  if (res.code < 200 || res.code >= 300) return 0;

  var pending;
  try {
    pending = JSON.parse(res.body).replies || [];
  } catch (e) {
    return 0;
  }

  var sent = 0;
  for (var i = 0; i < pending.length; i++) {
    var r = pending[i];
    var outcome = { id: r.id };
    try {
      // Replying to the message, rather than composing a new one, keeps it in
      // the same thread — which is how the recruiter's own inbox groups it,
      // and how their ATS ties it back to your application.
      var msg = GmailApp.getMessageById(r.message_id);
      if (!msg) throw new Error('message no longer in mailbox');
      msg.reply(r.reply_draft);
      outcome.state = 'sent';
      sent++;
    } catch (e) {
      outcome.state = 'failed';
      outcome.error = String(e.message || e).slice(0, 300);
    }
    post(cfg, ENDPOINT, { action: 'reply_result', result: outcome });
  }
  return sent;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function post(cfg, path, payload) {
  var res = UrlFetchApp.fetch(cfg.url + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-engine-key': cfg.secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return { code: res.getResponseCode(), body: res.getContentText() };
}

// ---------------------------------------------------------------------------
// Troubleshooting
// ---------------------------------------------------------------------------

/** Run this if something looks wrong. It changes nothing. */
function selfTest() {
  var cfg = requireConfig();
  Logger.log('Panel URL: ' + cfg.url);
  Logger.log('Secret length: ' + cfg.secret.length);
  Logger.log('Mailbox: ' + Session.getActiveUser().getEmail());
  Logger.log('Cursor: ' + (PROPS.getProperty('LAST_SEEN_MS')
    ? new Date(Number(PROPS.getProperty('LAST_SEEN_MS'))).toISOString()
    : 'not set (first run will look back ' + FIRST_RUN_DAYS + ' days)'));
  var res = post(cfg, ENDPOINT, { messages: [], heartbeat: true });
  Logger.log('ingest endpoint responded ' + res.code + ': ' + res.body.slice(0, 300));
  Logger.log('Triggers installed: ' + ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'sync'; }).length);
}

/** Forget the cursor and re-read the last week. Safe: duplicates are ignored. */
function resetCursor() {
  PROPS.deleteProperty('LAST_SEEN_MS');
  Logger.log('Cursor cleared. The next run looks back ' + FIRST_RUN_DAYS + ' days.');
}
