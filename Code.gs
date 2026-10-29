// Media Planner backend -- Apps Script web app serving media-planner-tool
// and media-planner-app. Storage is Postgres via Firebase SQL Connect
// (migrated off Google Sheets entity-by-entity 2026-10-08, confirmed
// complete via runAllTests()); Sheets remain only as an untouched,
// read-only historical backup. Read/write client pattern (JSONP reads,
// iframe-POST-then-verify writes) is shared by both frontends.

const PARENT_FOLDER_ID = '1tCaf4LoB1qcARLK2faKN2yYTxXMW96lh'; // "Media Planner Projects"

const SHEET_NAMES = {
  users: 'Users',
  projects: 'Projects',
  versions: 'Versions',
  teamRoster: 'TeamRoster',
  agencyHoldCo: 'AgencyHoldCo',
  holdCos: 'HoldCos',
  pitchTeams: 'PitchTeams',
  tentpoleShows: 'TentpoleShows',
  seasonYears: 'SeasonYears',
  tags: 'Tags',
  projectFileLinks: 'ProjectFileLinks',
  closedDeals: 'ClosedDeals',
  sponsorshipPackages: 'SponsorshipPackages',
  placementCategories: 'PlacementCategories',
  placementMenuItems: 'PlacementMenuItems',
};

// slackUserId is optional and manually entered (e.g. copied from a
// teammate's Slack profile "Copy member ID") — not resolved via any Slack
// API. Without it, that person's name appears as plain text in Slack
// notifications rather than a real, notifying mention.
const USER_FIELDS = ['email', 'name', 'role', 'slackUserId'];

// pitchLeadName isn't in the original ER diagram but is required input to
// derive pitchTeam (§5.1) — the current real Assignment sheet has an
// equivalent "Pitch Lead" column feeding the same Maps-tab lookup.
const PROJECT_FIELDS = [
  'id', 'projectName', 'account', 'brand', 'agency', 'holdCo',
  'leadMediaPlannerEmail', 'leadMediaPlanner2Email', 'leadSellerEmail', 'marketingProjectLead',
  'sponsorshipStrategyLead', 'salesAccountManager', 'yieldContact',
  'pitchLeadName', 'pitchTeam', 'rushRequest', 'mediaPlanStatus', 'dealStatus',
  'dealCategory', 'tentpoleShowId', 'seasonYearId', 'folderId', 'driveFolderLink',
  'salesforceLink', 'scratchpadLink', 'budgetSheetLink', 'sponsorshipPlansLink',
  'planRequestDate', 'planDueDate', 'campaignStartDate', 'campaignEndDate',
  'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
  'notifyEmails', // comma-separated emails, picked from the Users list on the Assignment form
  'tags', // comma-separated tag names, picked from the managed Tags list (§6.3, confirmed 2026-09-08)
];

const VERSION_FIELDS = [
  'id', 'projectId', 'name', 'completedDate', 'totalInvestment',
  'versionStatus', 'folderId', 'packages',
  'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
];

const TEAM_ROSTER_FIELDS = ['teamMemberName', 'pitchTeam'];
const AGENCY_HOLDCO_FIELDS = ['agency', 'holdCo'];

// HoldCo/PitchTeam (confirmed 2026-09-14) — standalone managed lists, the
// parent side of Agency/Pitch Lead's nesting, creatable before anything is
// assigned under them yet (e.g. onboarding a new HoldCo relationship ahead
// of any specific agency deal). Keyed on name, same natural-key convention
// as TeamRoster/AgencyHoldCo below.
const HOLDCO_FIELDS = ['name'];
const PITCH_TEAM_FIELDS = ['name'];

const TENTPOLE_SHOW_FIELDS = ['id', 'name'];

// Sponsorship Hub (in progress) — a single flexible label rather than
// separate structured year/season fields, since it needs to hold both
// "Season 51" and "2027" depending on the show. Nests under a specific
// Show via showId (confirmed 2026-09-23) — "Season 51" only means
// something under "Survivor" — so unlike Tentpole Shows itself, this is a
// genuine child record: deleting a Show deletes its Season/Years outright
// rather than orphaning them (see deleteRowsByForeignKey_).
const SEASON_YEAR_FIELDS = ['id', 'showId', 'name'];

// Sponsorship Hub catalog entity (confirmed 2026-09-23) — the pre-built
// packages/placements a planner can browse and attach to a project, kept
// as growing inventory rather than tied to any specific deal. `placements`
// and `blendGroups` are JSON blobs (see JSON_FIELDS) — arrays of objects,
// not their own sheets, since this is a build-a-Sheet-later export target
// rather than something needing per-placement querying yet.
const SPONSORSHIP_PACKAGE_FIELDS = [
  'id', 'showId', 'seasonYearId', 'name', 'status',
  'placements', 'blendGroups',
  'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
];

// Placement Menu (confirmed 2026-09-23) — a curated, human-facing menu on
// top of the calc engine's existing fixed 14-value placementType enum
// (calculations.js's categorizeSponsorshipLineItem), not a new
// categorization system. Each Category maps to exactly one placementType,
// so picking a menu item when building a Hub package automatically carries
// the correct revenue-type tag without the planner touching it directly.
const PLACEMENT_CATEGORY_FIELDS = ['id', 'name', 'placementType'];

// A menu item's `lines` is a JSON array (see JSON_FIELDS) of 1+ line
// templates (platform, description, size, and — only when rateMode is
// 'perLine' — their own costMethod/defaultRate) — a single-entry array is
// a simple one-line placement; multiple entries is a bundle (e.g.
// "Paramount Digital Package" in the real reference template expands into
// Billboard + Pre-Roll + 1A Midroll + Midroll as one unit). Picking one
// from the menu adds all of its lines to the package at once — matching
// the same grouped-line shape (isGrouped/groupItems) the External Plan
// Generator script already uses, not a new structure.
//
// rateMode (confirmed 2026-09-24) distinguishes two real bundle shapes
// from the reference template: 'perLine' (default) — each line carries
// its own rate, some intentionally blank ("bundled, no charge"); 'shared'
// — every line in the bundle is priced at one common CPM/Flat Fee/AV rate
// (sharedCostMethod/sharedRate), rather than forcing each line to either
// have its own rate or show as $0.
const PLACEMENT_MENU_ITEM_FIELDS = ['id', 'categoryId', 'name', 'rateMode', 'sharedCostMethod', 'sharedRate', 'lines'];

// §6.3 — managed tag vocabulary, confirmed 2026-09-08. Deliberately not
// free-form: assigning a tag to a project picks from this list; adding a
// new tag to the list is its own separate, deliberate action (mirrors the
// TentpoleShow "add new" pattern) rather than letting anyone type an
// arbitrary string inline, to avoid duplicate/inconsistent variants
// ("Priority" vs "priority" vs "High Priority").
//
// Replaces the shared ProjectFolders tree (§6.6, built earlier the same
// day) — removed after concluding a single-parent folder hierarchy was the
// wrong fit: real groupings overlap (a project can be "Q1" AND "Tentpole"
// AND "Priority" at once), which tags support and folders structurally
// can't. Browse (the separate tree+list page) is retired; this lives in
// the Assignment Log instead, consolidating "find/organize a project" into
// one page instead of two overlapping ones.
const TAG_FIELDS = ['id', 'name', 'color', 'createdAt', 'createdBy'];

// Project Files (§ Planner tool) started as Drive-upload-only; this lets a
// planner also point at something that already lives elsewhere (a client's
// shared deck, a WeTransfer link) without downloading and re-uploading it
// into Drive just to have it show up in the same list (confirmed 2026-09-10).
const PROJECT_FILE_LINK_FIELDS = ['id', 'projectId', 'name', 'url', 'createdAt', 'createdBy'];

// Same field names Supabase's closed_deals table already used (confirmed
// 2026-09-16) — deliberately, so media-planner-tool's buildSupabaseDealRow()
// row-shape mapping works unchanged against this sheet too. (The one-time
// historical migration from Supabase that originally seeded this data has
// since been removed -- confirmed 2026-10-12 it was never called again
// after the 2026-09-16 backfill, and wrote to the now-unused Sheets tab,
// not Postgres.)
const CLOSED_DEAL_FIELDS = [
  'deal_id', 'project_id', 'version_id', 'project_name', 'brand_name', 'sub_brand_name',
  'agency_name', 'version_name', 'deal_category', 'tentpole_show_name', 'deal_status',
  'verified_by', 'verified_at', 'verification_notes', 'marked_closed_at',
  'total_investment', 'total_margin_percent', 'snapshot', 'updated_at',
];

// Preset swatches only (confirmed 2026-09-10) — matches the managed-tag
// philosophy (§6.3): picking from a fixed palette keeps every tag visually
// distinct without letting anyone pick an illegible or clashing custom hex.
const TAG_COLORS = ['#0064FF', '#0E9F8E', '#C98A2C', '#C24463', '#7C5CBF', '#2B8A9E', '#8A8271', '#000A3C'];

// One-time setup — run manually from the Apps Script editor, not exposed via
// doGet/doPost. Seeds the caller as a write user and a couple of example
// roster rows (from the real Assignment/Logging sheet's Maps tab, §5.1) so
// the lookup derivation has something to resolve against immediately.
// Run this once from the Apps Script editor's "Run" button — clasp's
// headless deploy doesn't trigger the interactive OAuth consent dialog
// needed to grant new scopes (Drive access), only the browser IDE does.
function authorizeDriveAccess() {
  const testValues = { account: 'Debug', brand: 'Debug', projectName: 'Debug (delete me)', createdAt: new Date().toISOString() };
  createProjectFolder_(testValues);
  Logger.log(testValues.driveFolderLink);
}

// Same reasoning as authorizeDriveAccess — run once from the editor's "Run"
// button after adding MailApp/UrlFetchApp usage, to grant the new scopes.
function authorizeMailAndFetchAccess() {
  MailApp.sendEmail({ to: Session.getActiveUser().getEmail(), subject: 'Media Planner backend — authorization test', body: 'If you got this, MailApp is authorized.' });
  Logger.log('Mail sent to ' + Session.getActiveUser().getEmail());
}

function setupSchema() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_NAMES.users, USER_FIELDS);
  ensureSheet_(ss, SHEET_NAMES.projects, PROJECT_FIELDS);
  ensureSheet_(ss, SHEET_NAMES.versions, VERSION_FIELDS);
  const roster = ensureSheet_(ss, SHEET_NAMES.teamRoster, TEAM_ROSTER_FIELDS);
  const agencyHoldCo = ensureSheet_(ss, SHEET_NAMES.agencyHoldCo, AGENCY_HOLDCO_FIELDS);
  ensureSheet_(ss, SHEET_NAMES.holdCos, HOLDCO_FIELDS);
  ensureSheet_(ss, SHEET_NAMES.pitchTeams, PITCH_TEAM_FIELDS);
  ensureSheet_(ss, SHEET_NAMES.tentpoleShows, TENTPOLE_SHOW_FIELDS);
  ensureSheet_(ss, SHEET_NAMES.seasonYears, SEASON_YEAR_FIELDS);
  ensureSheet_(ss, SHEET_NAMES.sponsorshipPackages, SPONSORSHIP_PACKAGE_FIELDS);
  ensureSheet_(ss, SHEET_NAMES.placementCategories, PLACEMENT_CATEGORY_FIELDS);
  ensureSheet_(ss, SHEET_NAMES.placementMenuItems, PLACEMENT_MENU_ITEM_FIELDS);
  ensureSheet_(ss, SHEET_NAMES.tags, TAG_FIELDS);
  ensureSheet_(ss, SHEET_NAMES.projectFileLinks, PROJECT_FILE_LINK_FIELDS);
  ensureSheet_(ss, SHEET_NAMES.closedDeals, CLOSED_DEAL_FIELDS);

  const usersSheet = ss.getSheetByName(SHEET_NAMES.users);
  if (usersSheet.getLastRow() < 2) {
    usersSheet.appendRow([Session.getActiveUser().getEmail(), 'Admin', 'write', '']);
  }
  if (roster.getLastRow() < 2) {
    roster.appendRow(['Nicole Rosenberg', 'ROSENBERG']);
    roster.appendRow(['Bari Zibrak', 'ZIBRAK']);
  }
  if (agencyHoldCo.getLastRow() < 2) {
    agencyHoldCo.appendRow(['Agency D7', 'PMX']);
    agencyHoldCo.appendRow(['Carat', 'Dentsu']);
  }

  const sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && ss.getSheets().length > 1) ss.deleteSheet(sheet1);
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  return sheet;
}

// Auto-creates the sheet if it doesn't exist yet — lets a brand-new sheet
// (e.g. HoldCos/PitchTeams, added 2026-09-14) come into existence on first
// use via the normal read/write actions below, without needing setupSchema()
// manually re-run from the Apps Script editor.
function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// Cached (confirmed 2026-10-07) -- every list* action funnels through
// this one function, and it previously did a full getDataRange().getValues()
// read + a rowToObject_ pass (including JSON.parse-ing any JSON_FIELDS
// blob in every row) on every single call. A 45s CacheService cache used
// to wrap this (added when every entity still lived in Sheets, since
// concurrent reads under load could queue up behind Apps Script's own
// execution concurrency limits and blow past the client's timeout -- see
// jsonpRequest's own fail()/reason comment), but every entity has since
// been cut over to SQL Connect (confirmed 2026-10-08) -- readRows_ is now
// only called by one-time migrateXToSql functions and a couple of
// historical/diagnostic functions, none of which are on any live request
// path, so the cache (and the matching per-write invalidation in doPost)
// was removed 2026-10-13 as dead weight.
function readRows_(sheetName) {
  const sheet = getSheet_(sheetName);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  return data.slice(1).map(function (row) { return rowToObject_(headers, row); });
}

// Fields that store a nested JS object as a JSON string in the sheet cell —
// stringified on write, parsed back out on read. 'snapshot' (ClosedDeals)
// added 2026-09-16 alongside the original 'packages' (Versions).
const JSON_FIELDS = ['packages', 'snapshot', 'placements', 'blendGroups', 'lines'];

function rowToObject_(headers, row) {
  const obj = {};
  headers.forEach(function (header, i) {
    let value = row[i];
    if (JSON_FIELDS.includes(header) && typeof value === 'string' && value) {
      try {
        value = JSON.parse(value);
      } catch (err) {
        value = null;
      }
    } else if (value instanceof Date) {
      value = value.toISOString();
    } else if (value === '') {
      value = null;
    }
    obj[header] = value;
  });
  return obj;
}

// Emails are typed in by hand in Settings (trimmed, but case kept), while
// Session.getActiveUser() returns Google's own lowercase form. Confirmed
// 2026-10-28: a planner set to "write" in Settings was still treated as
// read-only, so every one of their saves was rejected. Compare
// case-insensitively, and if someone somehow has more than one row,
// prefer the one with write access.
function sameEmail_(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function getCurrentUser_() {
  const email = Session.getActiveUser().getEmail();
  const users = readRowsSql_(SHEET_NAMES.users); // cut over to SQL Connect 2026-10-08 (Phase 4)
  const matches = users.filter(function (u) { return sameEmail_(u.email, email); });
  const record = matches.find(function (u) { return u.role === 'write'; }) || matches[0];
  return {
    email: email,
    role: record ? record.role : 'read',
    name: record ? record.name : null,
    matchedUserRows: matches.map(function (u) { return u.email + ' (' + (u.role || 'no role') + ')'; }),
  };
}

function requireWrite_(user) {
  if (user.role !== 'write') {
    const detail = user.matchedUserRows && user.matchedUserRows.length
      ? 'Users entry: ' + user.matchedUserRows.join(', ')
      : 'no Users entry matches this email';
    throw new Error('Write access required for ' + user.email + ' (' + detail + ')');
  }
}

// Column order comes from the sheet's actual header row, not the `fields`
// array's order — appendRow/setValue are purely positional, so if PROJECT_FIELDS
// (etc.) grows over time, writing by array order silently misaligns every
// existing column after the insertion point. This adds any new fields as
// extra columns at the end instead, so growing the schema never shifts
// existing data (confirmed bug, fixed 2026-09-01).
function ensureColumns_(sheet, fields) {
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const missing = fields.filter(function (f) { return headers.indexOf(f) === -1; });
  if (missing.length > 0) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
  }
  return headers.concat(missing);
}

function appendRecord_(sheetName, fields, values) {
  const sheet = getSheet_(sheetName);
  const headers = ensureColumns_(sheet, fields);
  const row = headers.map(function (h) {
    let v = values[h];
    if (JSON_FIELDS.includes(h) && v && typeof v === 'object') v = JSON.stringify(v);
    return v === undefined || v === null ? '' : v;
  });
  sheet.appendRow(row);
}

function updateRecord_(sheetName, fields, idField, id, values) {
  const sheet = getSheet_(sheetName);
  const headers = ensureColumns_(sheet, fields);
  const data = sheet.getDataRange().getValues();
  const idIdx = headers.indexOf(idField);
  for (let r = 1; r < data.length; r++) {
    if (data[r][idIdx] === id) {
      fields.forEach(function (f) {
        if (Object.prototype.hasOwnProperty.call(values, f)) {
          let v = values[f];
          if (JSON_FIELDS.includes(f) && v && typeof v === 'object') v = JSON.stringify(v);
          const colIdx = headers.indexOf(f);
          sheet.getRange(r + 1, colIdx + 1).setValue(v);
        }
      });
      return true;
    }
  }
  return false;
}

// Generic single-row delete by exact match on one key field — for lookup
// tables with no synthetic id (TeamRoster, AgencyHoldCo), where the natural
// key IS the field to match on. Entities needing a cascade into other
// sheets (deleteTag_, deleteProject_) still get their own dedicated function.
function deleteRowByKey_(sheetName, fields, keyField, keyValue) {
  const sheet = getSheet_(sheetName);
  const headers = ensureColumns_(sheet, fields);
  const keyIdx = headers.indexOf(keyField);
  const data = sheet.getDataRange().getValues();
  for (let r = data.length - 1; r >= 1; r--) {
    if (data[r][keyIdx] === keyValue) {
      sheet.deleteRow(r + 1);
      return true;
    }
  }
  return false;
}

// deleteRowsByForeignKey_/cascadeForeignKey_/lookupValue_ (the Sheets-backed
// originals that deleteRowsByForeignKeySql_/cascadeForeignKeySql_/
// lookupValueSql_ below were built as SQL-Connect-backed siblings of) were
// removed 2026-10-13 once every entity finished its Phase 4 cutover and
// the last live call site switched to its _Sql_ equivalent -- confirmed
// via grep that nothing called the originals anymore.

// §5.1 — pitchTeam and holdCo are lookup-derived, never manually typed.
function lookupValueSql_(sheetName, keyField, key, valueField) {
  if (!key) return null;
  const rows = readRowsSql_(sheetName);
  const match = rows.find(function (r) { return r[keyField] === key; });
  return match ? match[valueField] : null;
}

function applyProjectLookups_(values) {
  if (values.pitchLeadName) {
    // cut over to SQL Connect 2026-10-08 (Phase 4)
    values.pitchTeam = lookupValueSql_(SHEET_NAMES.teamRoster, 'teamMemberName', values.pitchLeadName, 'pitchTeam');
  }
  if (values.agency) {
    // cut over to SQL Connect 2026-10-08 (Phase 4)
    values.holdCo = lookupValueSql_(SHEET_NAMES.agencyHoldCo, 'agency', values.agency, 'holdCo');
  }
}

// §5.2 — auto-creates a subfolder under the shared parent, named
// "{Account} - {Brand} - {ProjectName}" (confirmed 2026-08-31), nested
// under a "{year}" subfolder based on the project's creation year
// (confirmed 2026-10-06) so the parent folder doesn't become one giant
// flat list as project count grows across years.
function createProjectFolder_(values) {
  const name = [values.account, values.brand, values.projectName].filter(Boolean).join(' - ');
  const parent = DriveApp.getFolderById(PARENT_FOLDER_ID);
  const yearFolder = getOrCreateYearFolder_(parent, new Date(values.createdAt).getFullYear());
  const folder = yearFolder.createFolder(name || 'Untitled Project');
  values.folderId = folder.getId();
  values.driveFolderLink = folder.getUrl();
}

function getOrCreateYearFolder_(parent, year) {
  const name = String(year);
  const existing = parent.getFoldersByName(name);
  if (existing.hasNext()) return existing.next();
  return parent.createFolder(name);
}

// General-purpose file upload (confirmed 2026-09-04) — lets a planner
// attach any supporting document (signed IO, client PDF, screenshot, etc.)
// to a project's Drive folder from inside the app, instead of clicking
// through to Drive and finding the folder themselves. Content arrives
// base64-encoded (safe for a form POST body, unlike raw binary).
function uploadProjectAttachment_(projectId, filename, mimeType, contentBase64) {
  const project = readRowsSql_(SHEET_NAMES.projects).find(function (p) { return p.id === projectId; }); // cut over to SQL Connect 2026-10-08 (Phase 4)
  if (!project || !project.folderId) {
    throw new Error('Project has no Drive folder to upload to.');
  }
  const folder = DriveApp.getFolderById(project.folderId);
  const blob = Utilities.newBlob(Utilities.base64Decode(contentBase64), mimeType || 'application/octet-stream', filename);
  const file = folder.createFile(blob);
  return { id: file.getId(), name: file.getName(), url: file.getUrl() };
}

function listProjectFiles_(projectId) {
  const project = readRowsSql_(SHEET_NAMES.projects).find(function (p) { return p.id === projectId; }); // cut over to SQL Connect 2026-10-08 (Phase 4)
  if (!project || !project.folderId) return [];
  const folder = DriveApp.getFolderById(project.folderId);
  const files = folder.getFiles();
  const result = [];
  while (files.hasNext()) {
    const f = files.next();
    result.push({ id: f.getId(), name: f.getName(), url: f.getUrl(), lastUpdated: f.getLastUpdated().toISOString() });
  }
  return result;
}

// Automatically keeps one continuously-updated INTERNAL_*.json file in the
// project's Drive folder — replaces the old manual "Export Internal Plan"
// download-then-drag-into-Drive workflow (confirmed 2026-09-04). Overwrites
// the existing file by name rather than creating a new dated one each time,
// since this now fires automatically on every debounced sync, not on a
// deliberate user click.
function internalProjectFileName_(project) {
  const sanitizedName = (project.projectName || 'untitled').replace(/[^a-z0-9]/gi, '_').toLowerCase();
  return 'INTERNAL_' + sanitizedName + '.json';
}

function uploadProjectFile_(projectId, content) {
  const project = readRowsSql_(SHEET_NAMES.projects).find(function (p) { return p.id === projectId; }); // cut over to SQL Connect 2026-10-08 (Phase 4)
  if (!project || !project.folderId) return; // no Drive folder yet (e.g. legacy/imported project) — skip
  const filename = internalProjectFileName_(project);
  const folder = DriveApp.getFolderById(project.folderId);
  const existing = folder.getFilesByName(filename);
  if (existing.hasNext()) {
    existing.next().setContent(content);
  } else {
    folder.createFile(filename, content, MimeType.PLAIN_TEXT);
  }
}

// §6.1 step 5 — notifies the assigned Lead Media Planner plus anyone else
// picked on the Assignment form. Email works today via MailApp (no external
// service, generous Workspace quota). Slack posts to one pre-existing
// channel via an Incoming Webhook (Script Property SLACK_WEBHOOK_URL) — set
// that property in the Apps Script editor's Project Settings once a webhook
// exists; until then this just logs and skips, same as a missing recipient.
// Never blocks project creation — both paths are wrapped by the caller.
function sendAssignmentNotifications_(project) {
  const emails = [project.leadMediaPlannerEmail, project.leadMediaPlanner2Email]
    .concat((project.notifyEmails || '').split(','))
    .map(function (e) { return (e || '').trim(); })
    .filter(Boolean);
  if (emails.length === 0) return;

  const dedupedEmails = Array.from(new Set(emails));
  const subject = 'New Assignment: ' + (project.projectName || 'Untitled Project');
  const lines = [
    'Account / Brand: ' + [project.account, project.brand].filter(Boolean).join(' / '),
    project.agency ? 'Agency: ' + project.agency : null,
    project.planDueDate ? 'Plan Due: ' + project.planDueDate : null,
    project.rushRequest ? 'RUSH REQUEST' : null,
    project.driveFolderLink ? 'Drive folder: ' + project.driveFolderLink : null,
  ].filter(Boolean);
  const body = lines.join('\n');

  try {
    MailApp.sendEmail({ to: dedupedEmails.join(','), subject: subject, body: body });
  } catch (e) {
    Logger.log('Email notification failed: ' + e.message);
  }

  try {
    sendSlackNotification_(subject, lines, dedupedEmails);
  } catch (e) {
    Logger.log('Slack notification failed: ' + e.message);
  }
}

function sendSlackNotification_(subject, lines, emails) {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!webhookUrl) {
    Logger.log('Slack not configured (no SLACK_WEBHOOK_URL script property) — skipping.');
    return;
  }
  const users = readRowsSql_(SHEET_NAMES.users); // cut over to SQL Connect 2026-10-08 (Phase 4)
  const mentions = emails.map(function (email) {
    const user = users.find(function (u) { return sameEmail_(u.email, email); });
    if (user && user.slackUserId) return '<@' + user.slackUserId + '>';
    return (user && user.name) || email;
  });
  const text = '*' + subject + '*\n' + lines.join('\n') + '\nNotifying: ' + mentions.join(', ');
  UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text }),
  });
}

// Rejects a duplicate name (case-insensitive) rather than silently creating
// a near-identical variant ("Priority" vs "priority") — the whole point of
// a managed vocabulary over free-form tagging is avoiding this.
//
// cut over to SQL Connect 2026-10-08 (Phase 4, Tags first). The upfront
// .some() check below is now just a fast-path UX nicety (catches the
// common case without a round-trip to actually attempt the insert) --
// the REAL guarantee against a race (two people creating the same tag
// name at the same instant) is the `name @unique` index added to the Tag
// table 2026-10-13, which Postgres enforces atomically regardless of
// application-level timing. This is what let withLock_ be removed from
// every write action: concurrent requests used to need a shared lock to
// stay safe, since Sheets had no real transactions, but Postgres's own
// primary keys (every other entity's natural key) and this one explicit
// unique index (Tag.name is the only business-uniqueness rule that isn't
// already a primary key) now provide that guarantee natively.
function createTag_(values) {
  const existing = readRowsSql_(SHEET_NAMES.tags);
  const name = (values.name || '').trim();
  if (!name) throw new Error('Tag name is required.');
  if (existing.some(function (t) { return (t.name || '').toLowerCase() === name.toLowerCase(); })) {
    throw new Error('A tag named "' + name + '" already exists.');
  }
  const color = values.color || TAG_COLORS[existing.length % TAG_COLORS.length];
  try {
    appendRecordSql_(SHEET_NAMES.tags, TAG_FIELDS, { id: values.id, name: name, color: color, createdAt: values.createdAt, createdBy: values.createdBy });
  } catch (e) {
    if (e.dataConnectCode === 'ALREADY_EXISTS') {
      throw new Error('A tag named "' + name + '" already exists.');
    }
    throw e;
  }
}

// Cascades to Versions too (mirrors deleteTag_'s cascade philosophy) —
// otherwise a deleted project would leave orphaned version rows still
// showing up in the Plans Log with no parent to join against. Deliberately
// does NOT touch the Drive folder — deleting real files a planner may have
// uploaded is a much bigger, harder-to-reverse action than removing a sheet
// row, and isn't what "delete this project" was asked for.
function deleteProject_(projectId) {
  // cut over to SQL Connect 2026-10-08 (Phase 4)
  deleteRowsByForeignKeySql_(SHEET_NAMES.versions, VERSION_FIELDS, 'projectId', projectId);
  deleteRowsByForeignKeySql_(SHEET_NAMES.projectFileLinks, PROJECT_FILE_LINK_FIELDS, 'projectId', projectId);
  deleteRowByKeySql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'id', projectId);
}

// Removes a tag from the managed list and strips it from every project
// that had it assigned, so nothing is left pointing at a name that no
// longer exists in the vocabulary.
function deleteTag_(tagId) {
  // cut over to SQL Connect 2026-10-08 (Phase 4) -- this is a per-row
  // conditional string edit (strip one value out of a comma-separated
  // list), not a blanket field replace, so it doesn't fit the generic
  // bulk cascadeForeignKeySql_ pattern and stays a manual loop.
  const tags = readRowsSql_(SHEET_NAMES.tags);
  const tag = tags.find(function (t) { return t.id === tagId; });
  if (!tag) return;

  readRowsSql_(SHEET_NAMES.projects).forEach(function (p) {
    const projectTags = (p.tags || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    if (projectTags.includes(tag.name)) {
      const remaining = projectTags.filter(function (t) { return t !== tag.name; }).join(',');
      updateRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'id', p.id, { id: p.id, tags: remaining });
    }
  });

  deleteRowByKeySql_(SHEET_NAMES.tags, TAG_FIELDS, 'id', tagId);
}

function respond_(result, callback) {
  const body = JSON.stringify(result);
  return callback
    ? ContentService.createTextOutput(callback + '(' + body + ')').setMimeType(ContentService.MimeType.JAVASCRIPT)
    : ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const action = e.parameter.action;
  const callback = e.parameter.callback;
  let result;
  try {
    if (action === 'recentErrors') {
      requireWrite_(getCurrentUser_());
      result = readRecentErrors_();
    } else if (action === 'listProjectFiles') {
      result = listProjectFiles_(e.parameter.projectId);
    } else if (action === 'listProjectFileLinks') {
      result = readRowsSql_(SHEET_NAMES.projectFileLinks).filter(function (r) { return r.projectId === e.parameter.projectId; }); // cut over to SQL Connect 2026-10-08 (Phase 4)
    } else if (action === 'listTags') {
      result = readRowsSql_(SHEET_NAMES.tags); // cut over to SQL Connect 2026-10-08 (Phase 4, Tags first)
    } else if (action === 'listProjects') {
      result = readRowsSql_(SHEET_NAMES.projects); // cut over to SQL Connect 2026-10-08 (Phase 4)
    } else if (action === 'listVersions') {
      result = readRowsSql_(SHEET_NAMES.versions); // cut over to SQL Connect 2026-10-08 (Phase 4)
    } else if (action === 'listUsers') {
      result = readRowsSql_(SHEET_NAMES.users); // cut over to SQL Connect 2026-10-08 (Phase 4)
    } else if (action === 'listTeamRoster') {
      result = readRowsSql_(SHEET_NAMES.teamRoster); // cut over to SQL Connect 2026-10-08 (Phase 4)
    } else if (action === 'listAgencyHoldCo') {
      result = readRowsSql_(SHEET_NAMES.agencyHoldCo); // cut over to SQL Connect 2026-10-08 (Phase 4)
    } else if (action === 'listHoldCos') {
      result = readRowsSql_(SHEET_NAMES.holdCos); // cut over to SQL Connect 2026-10-08 (Phase 4)
    } else if (action === 'listPitchTeams') {
      result = readRowsSql_(SHEET_NAMES.pitchTeams); // cut over to SQL Connect 2026-10-08 (Phase 4)
    } else if (action === 'listClosedDeals') {
      result = readRowsSql_(SHEET_NAMES.closedDeals); // cut over to SQL Connect 2026-10-08 (Phase 4)
    } else if (action === 'listTentpoleShows') {
      result = readRowsSql_(SHEET_NAMES.tentpoleShows); // cut over to SQL Connect 2026-10-08 (Phase 4)
    } else if (action === 'listSeasonYears') {
      result = readRowsSql_(SHEET_NAMES.seasonYears); // cut over to SQL Connect 2026-10-08 (Phase 4)
    } else if (action === 'listSponsorshipPackages') {
      result = readRowsSql_(SHEET_NAMES.sponsorshipPackages); // cut over to SQL Connect 2026-10-08 (Phase 4)
    } else if (action === 'listPlacementCategories') {
      result = readRowsSql_(SHEET_NAMES.placementCategories); // cut over to SQL Connect 2026-10-08 (Phase 4)
    } else if (action === 'listPlacementMenuItems') {
      result = readRowsSql_(SHEET_NAMES.placementMenuItems); // cut over to SQL Connect 2026-10-08 (Phase 4)
    } else if (action === 'whoami') {
      result = getCurrentUser_();
    } else {
      result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err.message };
  }
  return respond_(result, callback);
}

// withLock_ (a single LockService.getScriptLock() wrapped around every
// write action) was removed entirely 2026-10-13. History: originally
// needed because Sheets has no real transactions -- a lock was the only
// way to prevent two concurrent writes from corrupting each other.
// Confirmed 2026-09-04 by a real concurrency test that narrowing the
// lock's scope (holding it only around the sheet mutation, not around
// slow I/O like Drive folder creation) wasn't enough on its own: 2 of 10
// concurrent test writes still timed out waiting for the lock and were
// silently lost (waitLock() throws outside try/finally, and doPost's
// response is unreadable anyway -- see comment below), since every write
// for every entity, for every user, still serialized through the one
// shared lock. Confirmed again 2026-10-13 under a 20-concurrent-write
// test (20 simultaneous createTag calls): individual writes took up to
// 15s to drain through the queue, with zero client-side indication of
// how long a save would actually take before the UI falsely reported
// success. Removed once Postgres's own guarantees made it unnecessary:
// every entity's natural key is already a real Postgres primary key
// (HoldCo/PitchTeam/AgencyHoldCo/TeamRoster/User/ClosedDeal by name/email/
// dealId, everything else by a generated id) except Tag.name, which
// isn't itself the primary key -- so a `name @unique` index was added to
// the Tag table specifically to cover that one case, and createTag_ now
// catches the resulting ALREADY_EXISTS error as the real race-safety
// backstop (see its own comment). This lets unrelated writes from
// different team members execute in true parallel instead of queuing
// behind each other.

// Response body is unreadable cross-origin (script.google.com sends
// X-Frame-Options: sameorigin, blocking any iframe response including
// postMessage — confirmed against the closed_deals pilot). Callers must
// verify writes via a follow-up doGet read, not this response.
// The Executions panel doesn't show doPost's error text (confirmed
// 2026-10-28: failed planner syncs showed only "Failed", with no way to
// expand them), and the browser never sees doPost's response either (see
// media-planner-app's appsScriptPost comment). So failures are recorded
// here -- last 20, in CacheService only, never the database -- and read
// back via doGet's recentErrors action (write users only).
const RECENT_ERRORS_KEY_ = 'recentErrors';
const RECENT_ERRORS_MAX_ = 20;

function doPost(e) {
  try {
    return doPostImpl_(e);
  } catch (err) {
    try {
      recordRecentError_(e, err);
    } catch (ignored) {
      // Never let error recording mask the real error.
    }
    throw err;
  }
}

function recordRecentError_(e, err) {
  const params = (e && e.parameter) || {};
  let email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (ignored) {}
  let id = '';
  try { id = params.payload ? (JSON.parse(params.payload).id || '') : (params.projectId || ''); } catch (ignored) {}
  const entry = {
    at: new Date().toISOString(),
    user: email,
    action: params.action || '',
    id: id,
    payloadChars: (params.payload || params.content || '').length,
    error: String((err && err.message) || err).slice(0, 2000),
  };
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const cache = CacheService.getScriptCache();
    let list = [];
    try { list = JSON.parse(cache.get(RECENT_ERRORS_KEY_) || '[]'); } catch (ignored) {}
    list.unshift(entry);
    cache.put(RECENT_ERRORS_KEY_, JSON.stringify(list.slice(0, RECENT_ERRORS_MAX_)), 21600); // 6h, CacheService's max
  } finally {
    lock.releaseLock();
  }
}

function readRecentErrors_() {
  try { return JSON.parse(CacheService.getScriptCache().get(RECENT_ERRORS_KEY_) || '[]'); }
  catch (e) { return []; }
}

function doPostImpl_(e) {
  const action = e.parameter.action;
  const user = getCurrentUser_();
  const values = e.parameter.payload ? JSON.parse(e.parameter.payload) : {};
  const now = new Date().toISOString();

  if (action === 'createTag') {
    requireWrite_(user);
    values.id = values.id || Utilities.getUuid();
    values.createdAt = now;
    values.createdBy = user.email;
    createTag_(values);
    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
  } else if (action === 'deleteTag') {
    requireWrite_(user);
    deleteTag_(values.id);
    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
  } else if (action === 'updateTag') {
    requireWrite_(user);
    updateRecordSql_(SHEET_NAMES.tags, TAG_FIELDS, 'id', values.id, values); // cut over to SQL Connect 2026-10-08 (Phase 4, Tags first)
    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
  } else if (action === 'deleteProject') {
    requireWrite_(user);
    deleteProject_(values.id);
    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
  } else if (action === 'addProjectFileLink') {
    requireWrite_(user);
    values.id = values.id || Utilities.getUuid();
    values.createdAt = now;
    values.createdBy = user.email;
    appendRecordSql_(SHEET_NAMES.projectFileLinks, PROJECT_FILE_LINK_FIELDS, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
  } else if (action === 'deleteProjectFileLink') {
    requireWrite_(user);
    deleteRowByKeySql_(SHEET_NAMES.projectFileLinks, PROJECT_FILE_LINK_FIELDS, 'id', values.id); // cut over to SQL Connect 2026-10-08 (Phase 4)
    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
  } else if (action === 'uploadProjectAttachment') {
    requireWrite_(user);
    uploadProjectAttachment_(e.parameter.projectId, e.parameter.filename, e.parameter.mimeType, e.parameter.contentBase64);
    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
  } else if (action === 'uploadProjectFile') {
    requireWrite_(user);
    uploadProjectFile_(e.parameter.projectId, e.parameter.content);
    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
  } else if (action === 'createProject') {
    requireWrite_(user);
    values.id = values.id || Utilities.getUuid();
    // §6.1 step 4 — Media Plan Status defaults to Pre-Planning; Deal
    // Status stays unset until the deal actually resolves (§6.2 step 5).
    values.mediaPlanStatus = values.mediaPlanStatus || 'Pre-Planning';
    values.createdAt = now;
    values.createdBy = user.email;
    values.updatedAt = now;
    values.updatedBy = user.email;
    applyProjectLookups_(values); // reads TeamRoster/AgencyHoldCo — different sheets, no lock needed
    createProjectFolder_(values); // Drive API call — slow, no shared-sheet state, no lock needed
    appendRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
    try {
      sendAssignmentNotifications_(values);
    } catch (e) {
      Logger.log('Assignment notifications failed: ' + e.message);
    }
  } else if (action === 'updateProject') {
    requireWrite_(user);
    values.updatedAt = now;
    values.updatedBy = user.email;
    applyProjectLookups_(values);
    updateRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'id', values.id, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'createVersion') {
    requireWrite_(user);
    values.id = values.id || Utilities.getUuid();
    values.createdAt = now;
    values.createdBy = user.email;
    values.updatedAt = now;
    values.updatedBy = user.email;
    appendRecordSql_(SHEET_NAMES.versions, VERSION_FIELDS, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'updateVersion') {
    requireWrite_(user);
    values.updatedAt = now;
    values.updatedBy = user.email;
    updateRecordSql_(SHEET_NAMES.versions, VERSION_FIELDS, 'id', values.id, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'deleteVersion') {
    requireWrite_(user);
    deleteRowByKeySql_(SHEET_NAMES.versions, VERSION_FIELDS, 'id', values.id); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'createTeamRosterEntry') {
    requireWrite_(user);
    appendRecordSql_(SHEET_NAMES.teamRoster, TEAM_ROSTER_FIELDS, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'createAgencyHoldCoEntry') {
    requireWrite_(user);
    appendRecordSql_(SHEET_NAMES.agencyHoldCo, AGENCY_HOLDCO_FIELDS, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'updateTeamRosterEntry') {
    requireWrite_(user);
    updateRecordSql_(SHEET_NAMES.teamRoster, TEAM_ROSTER_FIELDS, 'teamMemberName', values.teamMemberName, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'deleteTeamRosterEntry') {
    requireWrite_(user);
    deleteRowByKeySql_(SHEET_NAMES.teamRoster, TEAM_ROSTER_FIELDS, 'teamMemberName', values.teamMemberName); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'updateAgencyHoldCoEntry') {
    requireWrite_(user);
    updateRecordSql_(SHEET_NAMES.agencyHoldCo, AGENCY_HOLDCO_FIELDS, 'agency', values.agency, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'renameAgency') {
    // payload: { originalName, name } — originalName locates the row, name
    // is the new agency text, cascaded into every Project that referenced
    // the old name (same pattern as updateHoldCo below).
    requireWrite_(user);
    updateRecordSql_(SHEET_NAMES.agencyHoldCo, AGENCY_HOLDCO_FIELDS, 'agency', values.originalName, { agency: values.name }); // cut over to SQL Connect 2026-10-08 (Phase 4)
    cascadeForeignKeySql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'agency', values.originalName, values.name); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'deleteAgencyHoldCoEntry') {
    requireWrite_(user);
    deleteRowByKeySql_(SHEET_NAMES.agencyHoldCo, AGENCY_HOLDCO_FIELDS, 'agency', values.agency); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'createHoldCo') {
    requireWrite_(user);
    appendRecordSql_(SHEET_NAMES.holdCos, HOLDCO_FIELDS, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'updateHoldCo') {
    // payload: { originalName, name } — originalName locates the row,
    // name is the (possibly unchanged) new value, cascaded into every
    // AgencyHoldCo row that referenced the old name.
    requireWrite_(user);
    updateRecordSql_(SHEET_NAMES.holdCos, HOLDCO_FIELDS, 'name', values.originalName, { name: values.name }); // cut over to SQL Connect 2026-10-08 (Phase 4)
    cascadeForeignKeySql_(SHEET_NAMES.agencyHoldCo, AGENCY_HOLDCO_FIELDS, 'holdCo', values.originalName, values.name); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'deleteHoldCo') {
    requireWrite_(user);
    deleteRowByKeySql_(SHEET_NAMES.holdCos, HOLDCO_FIELDS, 'name', values.name); // cut over to SQL Connect 2026-10-08 (Phase 4)
    cascadeForeignKeySql_(SHEET_NAMES.agencyHoldCo, AGENCY_HOLDCO_FIELDS, 'holdCo', values.name, ''); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'createPitchTeam') {
    requireWrite_(user);
    appendRecordSql_(SHEET_NAMES.pitchTeams, PITCH_TEAM_FIELDS, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'updatePitchTeam') {
    requireWrite_(user);
    updateRecordSql_(SHEET_NAMES.pitchTeams, PITCH_TEAM_FIELDS, 'name', values.originalName, { name: values.name }); // cut over to SQL Connect 2026-10-08 (Phase 4)
    cascadeForeignKeySql_(SHEET_NAMES.teamRoster, TEAM_ROSTER_FIELDS, 'pitchTeam', values.originalName, values.name); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'deletePitchTeam') {
    requireWrite_(user);
    deleteRowByKeySql_(SHEET_NAMES.pitchTeams, PITCH_TEAM_FIELDS, 'name', values.name); // cut over to SQL Connect 2026-10-08 (Phase 4)
    cascadeForeignKeySql_(SHEET_NAMES.teamRoster, TEAM_ROSTER_FIELDS, 'pitchTeam', values.name, ''); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'createUser') {
    requireWrite_(user);
    values.role = values.role || 'read';
    appendRecordSql_(SHEET_NAMES.users, USER_FIELDS, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'updateUser') {
    // payload: { originalEmail, email, name, role? } — role is optional so a
    // plain name/email edit never accidentally touches it; only sent when
    // the Lead Media Planners settings page's role toggle is what changed
    // (confirmed 2026-09-14 — Write access is still a deliberate action,
    // just now one taken from this page instead of hand-editing the Sheet).
    requireWrite_(user);
    const patch = { email: values.email, name: values.name };
    if (values.role) patch.role = values.role;
    updateRecordSql_(SHEET_NAMES.users, USER_FIELDS, 'email', values.originalEmail, patch); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'deleteUser') {
    requireWrite_(user);
    deleteRowByKeySql_(SHEET_NAMES.users, USER_FIELDS, 'email', values.email); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'upsertClosedDeal') {
    // Mirrors Supabase's .upsert(row, {onConflict:'deal_id'}) semantics using
    // pieces that already exist — update in place if the deal_id is already
    // known, otherwise append a new row.
    requireWrite_(user);
    // cut over to SQL Connect 2026-10-08 (Phase 4)
    const updated = updateRecordSql_(SHEET_NAMES.closedDeals, CLOSED_DEAL_FIELDS, 'deal_id', values.deal_id, values);
    if (!updated) appendRecordSql_(SHEET_NAMES.closedDeals, CLOSED_DEAL_FIELDS, values);
  } else if (action === 'deleteClosedDeal') {
    requireWrite_(user);
    deleteRowByKeySql_(SHEET_NAMES.closedDeals, CLOSED_DEAL_FIELDS, 'deal_id', values.deal_id); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'createTentpoleShow') {
    requireWrite_(user);
    values.id = values.id || Utilities.getUuid();
    appendRecordSql_(SHEET_NAMES.tentpoleShows, TENTPOLE_SHOW_FIELDS, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'updateTentpoleShow') {
    // Keyed on the synthetic id (like Tags), not the name — renaming never
    // needs an old/new-key distinction the way HoldCo/PitchTeam's
    // natural-key rename does.
    requireWrite_(user);
    updateRecordSql_(SHEET_NAMES.tentpoleShows, TENTPOLE_SHOW_FIELDS, 'id', values.id, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'deleteTentpoleShow') {
    // Projects referencing this show keep their tentpoleShowId cleared, not
    // the project itself deleted — same non-destructive cascade philosophy
    // as deleteHoldCo_/deletePitchTeam. Season/Years are genuine children of
    // a Show (not just a soft reference the way Project's is), so those
    // rows are deleted outright rather than orphaned — and any project
    // pointing at one of them has its seasonYearId cleared the same way
    // tentpoleShowId is below.
    requireWrite_(user);
    const deletedSeasonYearIds = deleteRowsByForeignKeySql_(SHEET_NAMES.seasonYears, SEASON_YEAR_FIELDS, 'showId', values.id); // cut over to SQL Connect 2026-10-08 (Phase 4)
    deletedSeasonYearIds.forEach(function (seasonYearId) {
      cascadeForeignKeySql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'seasonYearId', seasonYearId, ''); // cut over to SQL Connect 2026-10-08 (Phase 4)
      cascadeForeignKeySql_(SHEET_NAMES.sponsorshipPackages, SPONSORSHIP_PACKAGE_FIELDS, 'seasonYearId', seasonYearId, ''); // cut over to SQL Connect 2026-10-08 (Phase 4)
    });
    deleteRowByKeySql_(SHEET_NAMES.tentpoleShows, TENTPOLE_SHOW_FIELDS, 'id', values.id); // cut over to SQL Connect 2026-10-08 (Phase 4)
    cascadeForeignKeySql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'tentpoleShowId', values.id, ''); // cut over to SQL Connect 2026-10-08 (Phase 4)
    // Sponsorship Hub packages are real built inventory, not a soft
    // reference — orphan (clear showId), never cascade-delete the
    // package itself just because its Show went away.
    cascadeForeignKeySql_(SHEET_NAMES.sponsorshipPackages, SPONSORSHIP_PACKAGE_FIELDS, 'showId', values.id, ''); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'createSeasonYear') {
    requireWrite_(user);
    values.id = values.id || Utilities.getUuid();
    appendRecordSql_(SHEET_NAMES.seasonYears, SEASON_YEAR_FIELDS, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'updateSeasonYear') {
    requireWrite_(user);
    updateRecordSql_(SHEET_NAMES.seasonYears, SEASON_YEAR_FIELDS, 'id', values.id, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'deleteSeasonYear') {
    // Projects and Sponsorship Hub packages referencing this season/year
    // keep it cleared, not deleted — same non-destructive cascade as
    // tentpoleShowId.
    requireWrite_(user);
    deleteRowByKeySql_(SHEET_NAMES.seasonYears, SEASON_YEAR_FIELDS, 'id', values.id); // cut over to SQL Connect 2026-10-08 (Phase 4)
    cascadeForeignKeySql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'seasonYearId', values.id, ''); // cut over to SQL Connect 2026-10-08 (Phase 4)
    cascadeForeignKeySql_(SHEET_NAMES.sponsorshipPackages, SPONSORSHIP_PACKAGE_FIELDS, 'seasonYearId', values.id, ''); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'createSponsorshipPackage') {
    requireWrite_(user);
    values.id = values.id || Utilities.getUuid();
    values.status = values.status || 'active';
    values.createdAt = now;
    values.createdBy = user.email;
    values.updatedAt = now;
    values.updatedBy = user.email;
    appendRecordSql_(SHEET_NAMES.sponsorshipPackages, SPONSORSHIP_PACKAGE_FIELDS, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'updateSponsorshipPackage') {
    requireWrite_(user);
    values.updatedAt = now;
    values.updatedBy = user.email;
    updateRecordSql_(SHEET_NAMES.sponsorshipPackages, SPONSORSHIP_PACKAGE_FIELDS, 'id', values.id, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'deleteSponsorshipPackage') {
    requireWrite_(user);
    deleteRowByKeySql_(SHEET_NAMES.sponsorshipPackages, SPONSORSHIP_PACKAGE_FIELDS, 'id', values.id); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'createPlacementCategory') {
    requireWrite_(user);
    values.id = values.id || Utilities.getUuid();
    appendRecordSql_(SHEET_NAMES.placementCategories, PLACEMENT_CATEGORY_FIELDS, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'updatePlacementCategory') {
    requireWrite_(user);
    updateRecordSql_(SHEET_NAMES.placementCategories, PLACEMENT_CATEGORY_FIELDS, 'id', values.id, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'deletePlacementCategory') {
    // Menu items are genuine children of a category (same reasoning as
    // Season/Year under Show) — deleted outright, not orphaned, since a
    // menu item with no category has nowhere to appear in the picker.
    requireWrite_(user);
    deleteRowsByForeignKeySql_(SHEET_NAMES.placementMenuItems, PLACEMENT_MENU_ITEM_FIELDS, 'categoryId', values.id); // cut over to SQL Connect 2026-10-08 (Phase 4)
    deleteRowByKeySql_(SHEET_NAMES.placementCategories, PLACEMENT_CATEGORY_FIELDS, 'id', values.id); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'createPlacementMenuItem') {
    requireWrite_(user);
    values.id = values.id || Utilities.getUuid();
    appendRecordSql_(SHEET_NAMES.placementMenuItems, PLACEMENT_MENU_ITEM_FIELDS, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'updatePlacementMenuItem') {
    requireWrite_(user);
    updateRecordSql_(SHEET_NAMES.placementMenuItems, PLACEMENT_MENU_ITEM_FIELDS, 'id', values.id, values); // cut over to SQL Connect 2026-10-08 (Phase 4)
  } else if (action === 'deletePlacementMenuItem') {
    requireWrite_(user);
    deleteRowByKeySql_(SHEET_NAMES.placementMenuItems, PLACEMENT_MENU_ITEM_FIELDS, 'id', values.id); // cut over to SQL Connect 2026-10-08 (Phase 4)
  }

  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}

// One-time backfill (confirmed 2026-10-06; run manually from the Apps
// Script editor's Run button, not exposed as a doPost action) — moves
// every existing project's folder, created back when all project
// folders sat flat under the parent, into a "{year}" subfolder matching
// its createdAt, to match what createProjectFolder_ now does for new
// projects. Safe to re-run: skips any project whose folder is already
// inside its correct year folder.
function migrateProjectFoldersIntoYearFolders() {
  const parent = DriveApp.getFolderById(PARENT_FOLDER_ID);
  const projects = readRows_(SHEET_NAMES.projects);
  let moved = 0, skipped = 0, failed = 0;
  projects.forEach(function (project) {
    if (!project.folderId || !project.createdAt) { skipped++; return; }
    try {
      const folder = DriveApp.getFolderById(project.folderId);
      const yearFolder = getOrCreateYearFolder_(parent, new Date(project.createdAt).getFullYear());
      const currentParents = folder.getParents();
      // The parent folder now lives in a Shared Drive (confirmed
      // 2026-10-06) -- Shared Drive items are strictly single-parent and
      // reject the legacy multi-parent addFolder/removeFolder reparent
      // trick ("Cannot use this operation on a shared drive item"), so
      // this needs the newer moveTo() reparent call instead.
      const alreadyThere = currentParents.hasNext() && currentParents.next().getId() === yearFolder.getId();
      if (alreadyThere) { skipped++; return; }
      folder.moveTo(yearFolder);
      moved++;
    } catch (e) {
      failed++;
      Logger.log('Failed to move folder for project ' + project.id + ': ' + e.message);
    }
  });
  Logger.log('Migration complete: moved=' + moved + ' skipped=' + skipped + ' failed=' + failed);
  return { moved: moved, skipped: skipped, failed: failed };
}

// testReadRowsCachePerformance (measured readRows_'s now-removed Sheets
// cache) and measureCurrentDataSize (ground a Firestore-free-tier estimate
// for a storage backend this project didn't end up choosing) were both
// removed 2026-10-13 -- neither has had anything left to measure since the
// SQL Connect migration completed.

// Confirmed 2026-10-08: ScriptApp.getOAuthToken() represents the human user
// running the script, not a service account -- and SQL Connect's
// @auth(level: NO_ACCESS) operations (the level we want for a trusted
// backend, per https://firebase.google.com/docs/sql-connect/authorization-and-security)
// specifically require an "Admin SDK context", which only a service-account
// identity satisfies, regardless of OAuth scope. Apps Script has no native
// service-account support, so this signs its own JWT assertion (the
// standard Apps Script + service-account pattern) and exchanges it for a
// real access token.
//
// The service account key JSON lives in Script Properties (key
// SQL_CONNECT_SERVICE_ACCOUNT_KEY), not in source -- it's a long-lived,
// powerful credential and must never be committed to git.
// Caches the access token (confirmed 2026-10-08) -- every call used to sign
// a fresh JWT and do a full OAuth token exchange before the actual GraphQL
// request, two serial network round-trips on every single SQL Connect call.
// That's tolerable for occasional list-page loads, but becomes a real
// latency/quota problem once a hot path like getCurrentUser_ (called on
// every doGet/doPost) is cut over to SQL. The JWT itself is valid 3600s;
// caching for 3000s (50 min) stays safely inside that window.
function getServiceAccountAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('sql_connect_access_token');
  if (cached) return cached;

  const keyJson = PropertiesService.getScriptProperties().getProperty('SQL_CONNECT_SERVICE_ACCOUNT_KEY');
  if (!keyJson) {
    throw new Error('SQL_CONNECT_SERVICE_ACCOUNT_KEY script property is not set.');
  }
  const key = JSON.parse(keyJson);
  const tokenUri = key.token_uri || 'https://oauth2.googleapis.com/token';

  const base64url_ = function (obj) {
    return Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  };
  const now = Math.floor(Date.now() / 1000);
  const unsigned = base64url_({ alg: 'RS256', typ: 'JWT' }) + '.' + base64url_({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  });
  const signature = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(unsigned, key.private_key)).replace(/=+$/, '');
  const jwt = unsigned + '.' + signature;

  const response = UrlFetchApp.fetch(tokenUri, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt },
    muteHttpExceptions: true,
  });
  const body = JSON.parse(response.getContentText());
  if (!body.access_token) {
    throw new Error('Failed to get service account access token: ' + response.getContentText());
  }
  cache.put('sql_connect_access_token', body.access_token, 3000);
  return body.access_token;
}

// One-time manual check (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- confirms the service-account JWT flow above
// actually satisfies SQL Connect's "Admin SDK context" requirement and can
// call the deployed connector's executeQuery endpoint.
function testDataConnectQuery() {
  const token = getServiceAccountAccessToken_();

  // Confirm the token itself is genuinely valid and see exactly which
  // identity/scope it represents, before blaming SQL Connect's permission
  // model for the 403 -- rules out a broken JWT signature/exchange first.
  const tokenInfo = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  Logger.log('Token info: ' + tokenInfo.getContentText());

  // Theory (confirmed 2026-10-08): the connector-scoped :executeQuery/
  // :executeMutation endpoints are the stable "public" surface generated
  // client SDKs call, and always enforce @auth regardless of caller --
  // the service-level :executeGraphql endpoint (what firebase-tools'
  // own `dataconnect:execute` CLI command uses, confirmed via --debug
  // output, and which worked fine against our NO_ACCESS operations) is
  // the actual IAM-gated admin/privileged path.
  const url = 'https://firebasedataconnect.googleapis.com/v1/projects/media-planner-f2113/locations/us-east4/services/media-planner-f2113-service:executeGraphql';
  const query = 'query ListTags { tags { id name color createdAt createdBy } }';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ query: query, operationName: 'ListTags', variables: {} }),
    muteHttpExceptions: true,
  });
  Logger.log('Status: ' + response.getResponseCode());
  Logger.log('Body: ' + response.getContentText());
}

// =====================================================================
// Phase 2 (confirmed 2026-10-08) -- SQL Connect (Postgres)-backed
// equivalents of the 6 generic Sheets storage helpers above
// (readRows_/appendRecord_/updateRecord_/deleteRowByKey_/
// deleteRowsByForeignKey_/cascadeForeignKey_), built and verified in
// isolation per the migration plan -- nothing in doPost's ~60 action
// handlers calls these yet. Phase 4 cuts over one entity at a time by
// changing specific call sites from e.g. readRows_(...) to
// readRowsSql_(...), not by replacing these 6 functions in place.
// =====================================================================

const DATA_CONNECT_URL_ = 'https://firebasedataconnect.googleapis.com/v1/projects/media-planner-f2113/locations/us-east4/services/media-planner-f2113-service:executeGraphql';

// The full set of queries/mutations Code.gs can execute, as one GraphQL
// document -- deliberately a separate, @auth-free copy of
// dataconnect/mediaplanner/{queries,mutations}.gql's operations (kept in
// sync by hand), not a reference into the deployed connector. Confirmed
// 2026-10-08: the connector-scoped :executeQuery/:executeMutation
// endpoints always enforce @auth regardless of caller; only the
// service-level :executeGraphql endpoint this calls (see
// getServiceAccountAccessToken_'s own comment) bypasses it, and that
// endpoint takes raw query text, not a reference to a pre-deployed named
// operation.
const DATA_CONNECT_OPERATIONS_ = `

query ListUsers {
  users(limit: 10000) {
    email
    name
    role
    slackUserId
  }
}

query ListTags {
  tags(limit: 10000) {
    id
    name
    color
    createdAt
    createdBy
  }
}

query ListHoldCos {
  holdCos(limit: 10000) {
    name
  }
}

query ListPitchTeams {
  pitchTeams(limit: 10000) {
    name
  }
}

query ListAgencyHoldCo {
  agencyHoldCos(limit: 10000) {
    agency
    holdCo
  }
}

query ListTeamRoster {
  teamRosters(limit: 10000) {
    teamMemberName
    pitchTeam
  }
}

query ListTentpoleShows {
  tentpoleShows(limit: 10000) {
    id
    name
  }
}

query ListSeasonYears {
  seasonYears(limit: 10000) {
    id
    showId
    name
  }
}

query ListPlacementCategories {
  placementCategories(limit: 10000) {
    id
    name
    placementType
  }
}

query ListPlacementMenuItems {
  placementMenuItems(limit: 10000) {
    id
    categoryId
    name
    rateMode
    sharedCostMethod
    sharedRate
    lines
  }
}

query ListProjects {
  projects(limit: 10000) {
    id
    projectName
    account
    brand
    agency
    holdCo
    leadMediaPlannerEmail
    leadMediaPlanner2Email
    leadSellerEmail
    sponsorshipStrategyLead
    salesAccountManager
    yieldContact
    pitchLeadName
    pitchTeam
    rushRequest
    mediaPlanStatus
    dealStatus
    dealCategory
    tentpoleShowId
    seasonYearId
    folderId
    driveFolderLink
    salesforceLink
    scratchpadLink
    budgetSheetLink
    sponsorshipPlansLink
    planRequestDate
    planDueDate
    campaignStartDate
    campaignEndDate
    tags
    createdAt
    createdBy
    updatedAt
    updatedBy
  }
}

query ListVersions {
  versions(limit: 10000) {
    id
    projectId
    name
    completedDate
    totalInvestment
    versionStatus
    folderId
    packages
    createdAt
    createdBy
    updatedAt
    updatedBy
  }
}

query ListSponsorshipPackages {
  sponsorshipPackages(limit: 10000) {
    id
    showId
    seasonYearId
    name
    status
    placements
    blendGroups
    createdAt
    createdBy
    updatedAt
    updatedBy
  }
}

query ListProjectFileLinks {
  projectFileLinks(limit: 10000) {
    id
    projectId
    name
    url
    createdAt
    createdBy
  }
}

query ListClosedDeals {
  closedDeals(limit: 10000) {
    dealId
    projectId
    versionId
    projectName
    brandName
    subBrandName
    agencyName
    versionName
    dealCategory
    tentpoleShowName
    dealStatus
    verifiedBy
    verifiedAt
    verificationNotes
    markedClosedAt
    totalInvestment
    totalMarginPercent
    snapshot
    updatedAt
  }
}

mutation CreateUser($email: String!, $name: String, $role: String, $slackUserId: String) {
  user_insert(data: { email: $email, name: $name, role: $role, slackUserId: $slackUserId })
}
mutation UpdateUser($originalEmail: String!, $email: String, $name: String, $role: String, $slackUserId: String) {
  user_update(key: { email: $originalEmail }, data: { email: $email, name: $name, role: $role, slackUserId: $slackUserId })
}
mutation DeleteUser($email: String!) {
  user_delete(key: { email: $email })
}

mutation CreateTag($id: String!, $name: String, $color: String, $createdAt: Timestamp, $createdBy: String) {
  tag_insert(data: { id: $id, name: $name, color: $color, createdAt: $createdAt, createdBy: $createdBy })
}
mutation UpdateTag($id: String!, $name: String, $color: String) {
  tag_update(key: { id: $id }, data: { name: $name, color: $color })
}
mutation DeleteTag($id: String!) {
  tag_delete(key: { id: $id })
}

mutation CreateHoldCo($name: String!) {
  holdCo_insert(data: { name: $name })
}
mutation UpdateHoldCo($originalName: String!, $name: String!) {
  holdCo_update(key: { name: $originalName }, data: { name: $name })
}
mutation DeleteHoldCo($name: String!) {
  holdCo_delete(key: { name: $name })
}

mutation CreatePitchTeam($name: String!) {
  pitchTeam_insert(data: { name: $name })
}
mutation UpdatePitchTeam($originalName: String!, $name: String!) {
  pitchTeam_update(key: { name: $originalName }, data: { name: $name })
}
mutation DeletePitchTeam($name: String!) {
  pitchTeam_delete(key: { name: $name })
}

mutation CreateAgencyHoldCoEntry($agency: String!, $holdCo: String) {
  agencyHoldCo_insert(data: { agency: $agency, holdCo: $holdCo })
}
mutation RenameAgency($originalAgency: String!, $agency: String, $holdCo: String) {
  agencyHoldCo_update(key: { agency: $originalAgency }, data: { agency: $agency, holdCo: $holdCo })
}
mutation DeleteAgencyHoldCoEntry($agency: String!) {
  agencyHoldCo_delete(key: { agency: $agency })
}

mutation CreateTeamRosterEntry($teamMemberName: String!, $pitchTeam: String) {
  teamRoster_insert(data: { teamMemberName: $teamMemberName, pitchTeam: $pitchTeam })
}
mutation UpdateTeamRosterEntry($teamMemberName: String!, $pitchTeam: String) {
  teamRoster_update(key: { teamMemberName: $teamMemberName }, data: { pitchTeam: $pitchTeam })
}
mutation DeleteTeamRosterEntry($teamMemberName: String!) {
  teamRoster_delete(key: { teamMemberName: $teamMemberName })
}

mutation CreateTentpoleShow($id: String!, $name: String) {
  tentpoleShow_insert(data: { id: $id, name: $name })
}
mutation UpdateTentpoleShow($id: String!, $name: String) {
  tentpoleShow_update(key: { id: $id }, data: { name: $name })
}
mutation DeleteTentpoleShow($id: String!) {
  tentpoleShow_delete(key: { id: $id })
}

mutation CreateSeasonYear($id: String!, $showId: String, $name: String) {
  seasonYear_insert(data: { id: $id, showId: $showId, name: $name })
}
mutation UpdateSeasonYear($id: String!, $showId: String, $name: String) {
  seasonYear_update(key: { id: $id }, data: { showId: $showId, name: $name })
}
mutation DeleteSeasonYear($id: String!) {
  seasonYear_delete(key: { id: $id })
}

mutation CreatePlacementCategory($id: String!, $name: String, $placementType: String) {
  placementCategory_insert(data: { id: $id, name: $name, placementType: $placementType })
}
mutation UpdatePlacementCategory($id: String!, $name: String, $placementType: String) {
  placementCategory_update(key: { id: $id }, data: { name: $name, placementType: $placementType })
}
mutation DeletePlacementCategory($id: String!) {
  placementCategory_delete(key: { id: $id })
}

mutation CreatePlacementMenuItem($id: String!, $categoryId: String, $name: String, $rateMode: String, $sharedCostMethod: String, $sharedRate: Float, $lines: String) {
  placementMenuItem_insert(data: { id: $id, categoryId: $categoryId, name: $name, rateMode: $rateMode, sharedCostMethod: $sharedCostMethod, sharedRate: $sharedRate, lines: $lines })
}
mutation UpdatePlacementMenuItem($id: String!, $categoryId: String, $name: String, $rateMode: String, $sharedCostMethod: String, $sharedRate: Float, $lines: String) {
  placementMenuItem_update(key: { id: $id }, data: { categoryId: $categoryId, name: $name, rateMode: $rateMode, sharedCostMethod: $sharedCostMethod, sharedRate: $sharedRate, lines: $lines })
}
mutation DeletePlacementMenuItem($id: String!) {
  placementMenuItem_delete(key: { id: $id })
}

mutation CreateProject(
  $id: String!, $projectName: String, $account: String, $brand: String, $agency: String, $holdCo: String,
  $leadMediaPlannerEmail: String, $leadMediaPlanner2Email: String, $leadSellerEmail: String,
  $sponsorshipStrategyLead: String, $salesAccountManager: String, $yieldContact: String,
  $pitchLeadName: String, $pitchTeam: String, $rushRequest: Boolean, $mediaPlanStatus: String, $dealStatus: String,
  $dealCategory: String, $tentpoleShowId: String, $seasonYearId: String, $folderId: String, $driveFolderLink: String,
  $salesforceLink: String, $scratchpadLink: String, $budgetSheetLink: String, $sponsorshipPlansLink: String,
  $planRequestDate: Date, $planDueDate: Date, $campaignStartDate: Date, $campaignEndDate: Date, $tags: String,
  $createdAt: Timestamp, $createdBy: String, $updatedAt: Timestamp, $updatedBy: String
) {
  project_insert(data: {
    id: $id, projectName: $projectName, account: $account, brand: $brand, agency: $agency, holdCo: $holdCo,
    leadMediaPlannerEmail: $leadMediaPlannerEmail, leadMediaPlanner2Email: $leadMediaPlanner2Email, leadSellerEmail: $leadSellerEmail,
    sponsorshipStrategyLead: $sponsorshipStrategyLead, salesAccountManager: $salesAccountManager, yieldContact: $yieldContact,
    pitchLeadName: $pitchLeadName, pitchTeam: $pitchTeam, rushRequest: $rushRequest, mediaPlanStatus: $mediaPlanStatus, dealStatus: $dealStatus,
    dealCategory: $dealCategory, tentpoleShowId: $tentpoleShowId, seasonYearId: $seasonYearId, folderId: $folderId, driveFolderLink: $driveFolderLink,
    salesforceLink: $salesforceLink, scratchpadLink: $scratchpadLink, budgetSheetLink: $budgetSheetLink, sponsorshipPlansLink: $sponsorshipPlansLink,
    planRequestDate: $planRequestDate, planDueDate: $planDueDate, campaignStartDate: $campaignStartDate, campaignEndDate: $campaignEndDate, tags: $tags,
    createdAt: $createdAt, createdBy: $createdBy, updatedAt: $updatedAt, updatedBy: $updatedBy
  })
}
mutation UpdateProject(
  $id: String!, $projectName: String, $account: String, $brand: String, $agency: String, $holdCo: String,
  $leadMediaPlannerEmail: String, $leadMediaPlanner2Email: String, $leadSellerEmail: String,
  $sponsorshipStrategyLead: String, $salesAccountManager: String, $yieldContact: String,
  $pitchLeadName: String, $pitchTeam: String, $rushRequest: Boolean, $mediaPlanStatus: String, $dealStatus: String,
  $dealCategory: String, $tentpoleShowId: String, $seasonYearId: String, $folderId: String, $driveFolderLink: String,
  $salesforceLink: String, $scratchpadLink: String, $budgetSheetLink: String, $sponsorshipPlansLink: String,
  $planRequestDate: Date, $planDueDate: Date, $campaignStartDate: Date, $campaignEndDate: Date, $tags: String,
  $updatedAt: Timestamp, $updatedBy: String
) {
  project_update(key: { id: $id }, data: {
    projectName: $projectName, account: $account, brand: $brand, agency: $agency, holdCo: $holdCo,
    leadMediaPlannerEmail: $leadMediaPlannerEmail, leadMediaPlanner2Email: $leadMediaPlanner2Email, leadSellerEmail: $leadSellerEmail,
    sponsorshipStrategyLead: $sponsorshipStrategyLead, salesAccountManager: $salesAccountManager, yieldContact: $yieldContact,
    pitchLeadName: $pitchLeadName, pitchTeam: $pitchTeam, rushRequest: $rushRequest, mediaPlanStatus: $mediaPlanStatus, dealStatus: $dealStatus,
    dealCategory: $dealCategory, tentpoleShowId: $tentpoleShowId, seasonYearId: $seasonYearId, folderId: $folderId, driveFolderLink: $driveFolderLink,
    salesforceLink: $salesforceLink, scratchpadLink: $scratchpadLink, budgetSheetLink: $budgetSheetLink, sponsorshipPlansLink: $sponsorshipPlansLink,
    planRequestDate: $planRequestDate, planDueDate: $planDueDate, campaignStartDate: $campaignStartDate, campaignEndDate: $campaignEndDate, tags: $tags,
    updatedAt: $updatedAt, updatedBy: $updatedBy
  })
}
mutation DeleteProject($id: String!) {
  project_delete(key: { id: $id })
}

mutation CreateVersion($id: String!, $projectId: String, $name: String, $completedDate: Date, $totalInvestment: Float, $versionStatus: String, $folderId: String, $packages: String, $createdAt: Timestamp, $createdBy: String, $updatedAt: Timestamp, $updatedBy: String) {
  version_insert(data: { id: $id, projectId: $projectId, name: $name, completedDate: $completedDate, totalInvestment: $totalInvestment, versionStatus: $versionStatus, folderId: $folderId, packages: $packages, createdAt: $createdAt, createdBy: $createdBy, updatedAt: $updatedAt, updatedBy: $updatedBy })
}
mutation UpdateVersion($id: String!, $projectId: String, $name: String, $completedDate: Date, $totalInvestment: Float, $versionStatus: String, $folderId: String, $packages: String, $updatedAt: Timestamp, $updatedBy: String) {
  version_update(key: { id: $id }, data: { projectId: $projectId, name: $name, completedDate: $completedDate, totalInvestment: $totalInvestment, versionStatus: $versionStatus, folderId: $folderId, packages: $packages, updatedAt: $updatedAt, updatedBy: $updatedBy })
}
mutation DeleteVersion($id: String!) {
  version_delete(key: { id: $id })
}

mutation CreateSponsorshipPackage($id: String!, $showId: String, $seasonYearId: String, $name: String, $status: String, $placements: String, $blendGroups: String, $createdAt: Timestamp, $createdBy: String, $updatedAt: Timestamp, $updatedBy: String) {
  sponsorshipPackage_insert(data: { id: $id, showId: $showId, seasonYearId: $seasonYearId, name: $name, status: $status, placements: $placements, blendGroups: $blendGroups, createdAt: $createdAt, createdBy: $createdBy, updatedAt: $updatedAt, updatedBy: $updatedBy })
}
mutation UpdateSponsorshipPackage($id: String!, $showId: String, $seasonYearId: String, $name: String, $status: String, $placements: String, $blendGroups: String, $updatedAt: Timestamp, $updatedBy: String) {
  sponsorshipPackage_update(key: { id: $id }, data: { showId: $showId, seasonYearId: $seasonYearId, name: $name, status: $status, placements: $placements, blendGroups: $blendGroups, updatedAt: $updatedAt, updatedBy: $updatedBy })
}
mutation DeleteSponsorshipPackage($id: String!) {
  sponsorshipPackage_delete(key: { id: $id })
}

mutation CreateProjectFileLink($id: String!, $projectId: String, $name: String, $url: String, $createdAt: Timestamp, $createdBy: String) {
  projectFileLink_insert(data: { id: $id, projectId: $projectId, name: $name, url: $url, createdAt: $createdAt, createdBy: $createdBy })
}
mutation DeleteProjectFileLink($id: String!) {
  projectFileLink_delete(key: { id: $id })
}

mutation UpdateClosedDeal(
  $dealId: String!, $projectId: String, $versionId: String, $projectName: String, $brandName: String, $subBrandName: String,
  $agencyName: String, $versionName: String, $dealCategory: String, $tentpoleShowName: String, $dealStatus: String,
  $verifiedBy: String, $verifiedAt: Timestamp, $verificationNotes: String, $markedClosedAt: Timestamp,
  $totalInvestment: Float, $totalMarginPercent: Float, $snapshot: String, $updatedAt: Timestamp
) {
  closedDeal_update(key: { dealId: $dealId }, data: {
    projectId: $projectId, versionId: $versionId, projectName: $projectName, brandName: $brandName, subBrandName: $subBrandName,
    agencyName: $agencyName, versionName: $versionName, dealCategory: $dealCategory, tentpoleShowName: $tentpoleShowName, dealStatus: $dealStatus,
    verifiedBy: $verifiedBy, verifiedAt: $verifiedAt, verificationNotes: $verificationNotes, markedClosedAt: $markedClosedAt,
    totalInvestment: $totalInvestment, totalMarginPercent: $totalMarginPercent, snapshot: $snapshot, updatedAt: $updatedAt
  })
}

mutation UpsertClosedDeal(
  $dealId: String!, $projectId: String, $versionId: String, $projectName: String, $brandName: String, $subBrandName: String,
  $agencyName: String, $versionName: String, $dealCategory: String, $tentpoleShowName: String, $dealStatus: String,
  $verifiedBy: String, $verifiedAt: Timestamp, $verificationNotes: String, $markedClosedAt: Timestamp,
  $totalInvestment: Float, $totalMarginPercent: Float, $snapshot: String, $updatedAt: Timestamp
) {
  closedDeal_upsert(data: {
    dealId: $dealId, projectId: $projectId, versionId: $versionId, projectName: $projectName, brandName: $brandName, subBrandName: $subBrandName,
    agencyName: $agencyName, versionName: $versionName, dealCategory: $dealCategory, tentpoleShowName: $tentpoleShowName, dealStatus: $dealStatus,
    verifiedBy: $verifiedBy, verifiedAt: $verifiedAt, verificationNotes: $verificationNotes, markedClosedAt: $markedClosedAt,
    totalInvestment: $totalInvestment, totalMarginPercent: $totalMarginPercent, snapshot: $snapshot, updatedAt: $updatedAt
  })
}
mutation DeleteClosedDeal($dealId: String!) {
  closedDeal_delete(key: { dealId: $dealId })
}

mutation UpdateProjectsByAgency($oldValue: String, $newValue: String) {
  project_updateMany(where: { agency: { eq: $oldValue } }, data: { agency: $newValue })
}
mutation UpdateProjectsBySeasonYearId($oldValue: String, $newValue: String) {
  project_updateMany(where: { seasonYearId: { eq: $oldValue } }, data: { seasonYearId: $newValue })
}
mutation UpdateProjectsByTentpoleShowId($oldValue: String, $newValue: String) {
  project_updateMany(where: { tentpoleShowId: { eq: $oldValue } }, data: { tentpoleShowId: $newValue })
}
mutation UpdateAgencyHoldCoByHoldCo($oldValue: String, $newValue: String) {
  agencyHoldCo_updateMany(where: { holdCo: { eq: $oldValue } }, data: { holdCo: $newValue })
}
mutation UpdateTeamRosterByPitchTeam($oldValue: String, $newValue: String) {
  teamRoster_updateMany(where: { pitchTeam: { eq: $oldValue } }, data: { pitchTeam: $newValue })
}
mutation UpdateSponsorshipPackagesBySeasonYearId($oldValue: String, $newValue: String) {
  sponsorshipPackage_updateMany(where: { seasonYearId: { eq: $oldValue } }, data: { seasonYearId: $newValue })
}
mutation UpdateSponsorshipPackagesByShowId($oldValue: String, $newValue: String) {
  sponsorshipPackage_updateMany(where: { showId: { eq: $oldValue } }, data: { showId: $newValue })
}

mutation DeleteSeasonYearsByShowId($showId: String) {
  seasonYear_deleteMany(where: { showId: { eq: $showId } })
}
mutation DeletePlacementMenuItemsByCategoryId($categoryId: String) {
  placementMenuItem_deleteMany(where: { categoryId: { eq: $categoryId } })
}
mutation DeleteProjectFileLinksByProjectId($projectId: String) {
  projectFileLink_deleteMany(where: { projectId: { eq: $projectId } })
}
mutation DeleteVersionsByProjectId($projectId: String) {
  version_deleteMany(where: { projectId: { eq: $projectId } })
}
`;

// Confirmed 2026-10-12 (via runAllTests): under sustained load, the SQL
// Connect API occasionally returns a non-JSON HTML error page instead of
// a GraphQL response (an infrastructure-level 5xx, not a GraphQL-level
// error -- those still come back as JSON with a body.errors array,
// handled below as before). Without this, that surfaced as a cryptic
// "Unexpected token '<' ... is not valid JSON" with no indication of what
// actually went wrong, for what is usually a transient blip that clears
// up a moment later -- one retry after a short pause, same philosophy as
// jsonpRequest's own retry-before-surfacing-an-error logic on the
// frontend side.
function executeDataConnect_(operationName, variables, _isRetry) {
  const response = UrlFetchApp.fetch(DATA_CONNECT_URL_, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + getServiceAccountAccessToken_() },
    payload: JSON.stringify({ query: DATA_CONNECT_OPERATIONS_, operationName: operationName, variables: variables || {} }),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  const text = response.getContentText();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    if (!_isRetry) {
      Utilities.sleep(500);
      return executeDataConnect_(operationName, variables, true);
    }
    throw new Error('Data Connect returned a non-JSON response (HTTP ' + status + ') for ' + operationName + ': ' + text.slice(0, 200));
  }
  if (body.errors) {
    const err = new Error('Data Connect error in ' + operationName + ': ' + JSON.stringify(body.errors));
    // Structured code (e.g. 'ALREADY_EXISTS' for a unique-constraint
    // violation, confirmed 2026-10-13) attached separately so callers can
    // react to a specific failure class without parsing the message string.
    err.dataConnectCode = body.errors[0] && body.errors[0].extensions && body.errors[0].extensions.code;
    throw err;
  }
  return body.data;
}

// ClosedDeal is the one entity whose Code.gs field names (CLOSED_DEAL_FIELDS,
// snake_case, matching Supabase's existing closed_deals table) don't match
// its GraphQL field names (camelCase, required by Data Connect -- see
// schema.gql's own comment). Every other entity's fields already match 1:1.
const CLOSED_DEAL_FIELD_TO_GQL_ = {
  deal_id: 'dealId', project_id: 'projectId', version_id: 'versionId', project_name: 'projectName',
  brand_name: 'brandName', sub_brand_name: 'subBrandName', agency_name: 'agencyName', version_name: 'versionName',
  deal_category: 'dealCategory', tentpole_show_name: 'tentpoleShowName', deal_status: 'dealStatus',
  verified_by: 'verifiedBy', verified_at: 'verifiedAt', verification_notes: 'verificationNotes',
  marked_closed_at: 'markedClosedAt', total_investment: 'totalInvestment', total_margin_percent: 'totalMarginPercent',
  snapshot: 'snapshot', updated_at: 'updatedAt',
};
const CLOSED_DEAL_FIELD_FROM_GQL_ = (function () {
  const inverted = {};
  Object.keys(CLOSED_DEAL_FIELD_TO_GQL_).forEach(function (k) { inverted[CLOSED_DEAL_FIELD_TO_GQL_[k]] = k; });
  return inverted;
})();

// Maps each SHEET_NAMES value to what the 6 functions below need: the list
// query's operation/root-field names, the create/delete operation names,
// and the update operation name + the name of its "key" variable (mostly
// the same as the entity's own key field -- "originalX" for the 4 entities
// whose key can be renamed via the generic updateRecord_ call shape; see
// dataconnect/mediaplanner/mutations.gql's own comments on RenameAgency/
// UpdateUser/UpdateHoldCo/UpdatePitchTeam for why).
const DC_ENTITY_ = {};
DC_ENTITY_[SHEET_NAMES.users] = { type: 'user', listOp: 'ListUsers', listField: 'users', createOp: 'CreateUser', updateOp: 'UpdateUser', updateKeyVar: 'originalEmail', deleteOp: 'DeleteUser' };
DC_ENTITY_[SHEET_NAMES.tags] = { type: 'tag', listOp: 'ListTags', listField: 'tags', createOp: 'CreateTag', updateOp: 'UpdateTag', updateKeyVar: 'id', deleteOp: 'DeleteTag' };
DC_ENTITY_[SHEET_NAMES.holdCos] = { type: 'holdCo', listOp: 'ListHoldCos', listField: 'holdCos', createOp: 'CreateHoldCo', updateOp: 'UpdateHoldCo', updateKeyVar: 'originalName', deleteOp: 'DeleteHoldCo' };
DC_ENTITY_[SHEET_NAMES.pitchTeams] = { type: 'pitchTeam', listOp: 'ListPitchTeams', listField: 'pitchTeams', createOp: 'CreatePitchTeam', updateOp: 'UpdatePitchTeam', updateKeyVar: 'originalName', deleteOp: 'DeletePitchTeam' };
DC_ENTITY_[SHEET_NAMES.agencyHoldCo] = { type: 'agencyHoldCo', listOp: 'ListAgencyHoldCo', listField: 'agencyHoldCos', createOp: 'CreateAgencyHoldCoEntry', updateOp: 'RenameAgency', updateKeyVar: 'originalAgency', deleteOp: 'DeleteAgencyHoldCoEntry' };
DC_ENTITY_[SHEET_NAMES.teamRoster] = { type: 'teamRoster', listOp: 'ListTeamRoster', listField: 'teamRosters', createOp: 'CreateTeamRosterEntry', updateOp: 'UpdateTeamRosterEntry', updateKeyVar: 'teamMemberName', deleteOp: 'DeleteTeamRosterEntry' };
DC_ENTITY_[SHEET_NAMES.tentpoleShows] = { type: 'tentpoleShow', listOp: 'ListTentpoleShows', listField: 'tentpoleShows', createOp: 'CreateTentpoleShow', updateOp: 'UpdateTentpoleShow', updateKeyVar: 'id', deleteOp: 'DeleteTentpoleShow' };
DC_ENTITY_[SHEET_NAMES.seasonYears] = { type: 'seasonYear', listOp: 'ListSeasonYears', listField: 'seasonYears', createOp: 'CreateSeasonYear', updateOp: 'UpdateSeasonYear', updateKeyVar: 'id', deleteOp: 'DeleteSeasonYear' };
DC_ENTITY_[SHEET_NAMES.placementCategories] = { type: 'placementCategory', listOp: 'ListPlacementCategories', listField: 'placementCategories', createOp: 'CreatePlacementCategory', updateOp: 'UpdatePlacementCategory', updateKeyVar: 'id', deleteOp: 'DeletePlacementCategory' };
DC_ENTITY_[SHEET_NAMES.placementMenuItems] = { type: 'placementMenuItem', listOp: 'ListPlacementMenuItems', listField: 'placementMenuItems', createOp: 'CreatePlacementMenuItem', updateOp: 'UpdatePlacementMenuItem', updateKeyVar: 'id', deleteOp: 'DeletePlacementMenuItem' };
// PROJECT_FIELDS still includes marketingProjectLead/notifyEmails --
// confirmed dead/legacy columns this session (the client stopped
// collecting/sending them), deliberately excluded from schema.gql, so
// appendRecordSql_/updateRecordSql_ must skip them rather than send them
// as unrecognized GraphQL variables.
DC_ENTITY_[SHEET_NAMES.projects] = { type: 'project', listOp: 'ListProjects', listField: 'projects', createOp: 'CreateProject', updateOp: 'UpdateProject', updateKeyVar: 'id', deleteOp: 'DeleteProject', excludeFields: ['marketingProjectLead', 'notifyEmails'] };
DC_ENTITY_[SHEET_NAMES.versions] = { type: 'version', listOp: 'ListVersions', listField: 'versions', createOp: 'CreateVersion', updateOp: 'UpdateVersion', updateKeyVar: 'id', deleteOp: 'DeleteVersion' };
DC_ENTITY_[SHEET_NAMES.sponsorshipPackages] = { type: 'sponsorshipPackage', listOp: 'ListSponsorshipPackages', listField: 'sponsorshipPackages', createOp: 'CreateSponsorshipPackage', updateOp: 'UpdateSponsorshipPackage', updateKeyVar: 'id', deleteOp: 'DeleteSponsorshipPackage' };
DC_ENTITY_[SHEET_NAMES.projectFileLinks] = { type: 'projectFileLink', listOp: 'ListProjectFileLinks', listField: 'projectFileLinks', createOp: 'CreateProjectFileLink', deleteOp: 'DeleteProjectFileLink' }; // no update action exists for this entity
DC_ENTITY_[SHEET_NAMES.closedDeals] = { type: 'closedDeal', listOp: 'ListClosedDeals', listField: 'closedDeals', createOp: 'UpsertClosedDeal', updateOp: 'UpdateClosedDeal', updateKeyVar: 'dealId', deleteOp: 'DeleteClosedDeal', fieldMap: CLOSED_DEAL_FIELD_TO_GQL_, fieldMapReverse: CLOSED_DEAL_FIELD_FROM_GQL_ };

// Same JSON_FIELDS convention as rowToObject_/appendRecord_ above --
// packages/snapshot/placements/blendGroups/lines are still plain text
// columns in Postgres (deliberately not normalized into child tables yet,
// see schema.gql's own header comment), so the same stringify-on-write/
// parse-on-read behavior must be preserved exactly.
// Every non-String column in schema.gql (Date/Timestamp/Float, all
// nullable). Confirmed 2026-10-16: the web form sends an untouched date
// input as "", which Sheets happily stored but Postgres's Date type
// rejects outright ("$planDueDate is invalid Date: string \"\" is not in
// YYYY-MM-DD format") -- failing the whole createProject. Blank means
// "no value" for these, so it's sent as null. String columns are left
// alone: the frontends read "" back and call .trim() etc. on it.
const DC_NON_STRING_FIELDS_ = [
  'planRequestDate', 'planDueDate', 'campaignStartDate', 'campaignEndDate', 'completedDate',
  'createdAt', 'updatedAt', 'verifiedAt', 'markedClosedAt', 'verified_at', 'marked_closed_at', 'updated_at',
  'sharedRate', 'totalInvestment', 'totalMarginPercent', 'total_investment', 'total_margin_percent',
];

// Date (day-only) columns. Confirmed 2026-10-28: the planner tool sent
// completedDate as a full ISO timestamp, which Postgres's Date type
// rejects -- trimmed to its YYYY-MM-DD day here so any caller doing the
// same still saves.
const DC_DATE_FIELDS_ = ['planRequestDate', 'planDueDate', 'campaignStartDate', 'campaignEndDate', 'completedDate'];

function dcStringifyJsonFields_(values) {
  const out = {};
  Object.keys(values).forEach(function (k) {
    const v = values[k];
    if (DC_NON_STRING_FIELDS_.includes(k) && v === '') {
      out[k] = null;
      return;
    }
    if (DC_DATE_FIELDS_.includes(k) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      out[k] = v.slice(0, 10);
      return;
    }
    out[k] = (JSON_FIELDS.includes(k) && v && typeof v === 'object') ? JSON.stringify(v) : v;
  });
  return out;
}
function dcParseJsonFieldsInRow_(row) {
  const out = {};
  Object.keys(row).forEach(function (k) {
    let v = row[k];
    if (JSON_FIELDS.includes(k) && typeof v === 'string' && v) {
      try { v = JSON.parse(v); } catch (e) { v = null; }
    }
    out[k] = v === undefined ? null : v;
  });
  return out;
}

function readRowsSql_(sheetName) {
  const entity = DC_ENTITY_[sheetName];
  const data = executeDataConnect_(entity.listOp, {});
  const rows = data[entity.listField];
  return rows.map(function (row) {
    const mapped = entity.fieldMapReverse ? dcRemapKeys_(row, entity.fieldMapReverse) : row;
    return dcParseJsonFieldsInRow_(mapped);
  });
}

function dcRemapKeys_(obj, keyMap) {
  const out = {};
  Object.keys(obj).forEach(function (k) { out[keyMap[k] || k] = obj[k]; });
  return out;
}

function appendRecordSql_(sheetName, fields, values) {
  const entity = DC_ENTITY_[sheetName];
  const stringified = dcStringifyJsonFields_(values);
  const variables = {};
  fields.forEach(function (f) {
    if (entity.excludeFields && entity.excludeFields.includes(f)) return;
    const gqlKey = entity.fieldMap ? (entity.fieldMap[f] || f) : f;
    variables[gqlKey] = stringified[f] === undefined ? null : stringified[f];
  });
  executeDataConnect_(entity.createOp, variables);
}

function updateRecordSql_(sheetName, fields, idField, id, values) {
  const entity = DC_ENTITY_[sheetName];
  const stringified = dcStringifyJsonFields_(values);
  const variables = {};
  variables[entity.updateKeyVar] = id;
  fields.forEach(function (f) {
    if (entity.excludeFields && entity.excludeFields.includes(f)) return;
    if (f === idField && entity.updateKeyVar === idField) return; // avoid redundant re-send when key var IS the field name itself
    if (Object.prototype.hasOwnProperty.call(values, f)) {
      const gqlKey = entity.fieldMap ? (entity.fieldMap[f] || f) : f;
      variables[gqlKey] = stringified[f] === undefined ? null : stringified[f];
    }
  });
  const data = executeDataConnect_(entity.updateOp, variables);
  const rootField = entity.type + '_update';
  return !!data[rootField];
}

// Every DeleteX mutation in dataconnect/mediaplanner/mutations.gql uses
// the plain keyField name as its variable (confirmed by inspection --
// unlike update mutations, none of the 4 renameable entities need a
// different delete shape, since deleting by the current key value is
// unambiguous either way), so this is simpler than updateRecordSql_.
function deleteRowByKeySql_(sheetName, fields, keyField, keyValue) {
  const entity = DC_ENTITY_[sheetName];
  const variables = {};
  // ClosedDeal is the one entity with a fieldMap (snake_case Code.gs fields
  // vs. camelCase GraphQL variables, e.g. deal_id -> dealId) -- confirmed
  // 2026-10-08 this was missing here (every other DeleteX mutation's key
  // variable happens to already be camelCase, so this went unnoticed until
  // ClosedDeal's cutover).
  const gqlKey = entity.fieldMap ? (entity.fieldMap[keyField] || keyField) : keyField;
  variables[gqlKey] = keyValue;
  const data = executeDataConnect_(entity.deleteOp, variables);
  const rootField = entity.type + '_delete';
  return !!data[rootField];
}

// Bulk operations only exist for the specific (entity, foreign key field)
// pairs Code.gs's real cascadeForeignKey_/deleteRowsByForeignKey_ call
// sites use (see dataconnect/mediaplanner/mutations.gql's own comment) --
// this lookup intentionally throws for any other combination rather than
// silently doing nothing, so a new, un-anticipated call site fails loudly
// during Phase 4 instead of quietly no-oping in production.
const DC_BULK_UPDATE_OP_ = {};
DC_BULK_UPDATE_OP_[SHEET_NAMES.projects + '|agency'] = 'UpdateProjectsByAgency';
DC_BULK_UPDATE_OP_[SHEET_NAMES.projects + '|seasonYearId'] = 'UpdateProjectsBySeasonYearId';
DC_BULK_UPDATE_OP_[SHEET_NAMES.projects + '|tentpoleShowId'] = 'UpdateProjectsByTentpoleShowId';
DC_BULK_UPDATE_OP_[SHEET_NAMES.agencyHoldCo + '|holdCo'] = 'UpdateAgencyHoldCoByHoldCo';
DC_BULK_UPDATE_OP_[SHEET_NAMES.teamRoster + '|pitchTeam'] = 'UpdateTeamRosterByPitchTeam';
DC_BULK_UPDATE_OP_[SHEET_NAMES.sponsorshipPackages + '|seasonYearId'] = 'UpdateSponsorshipPackagesBySeasonYearId';
DC_BULK_UPDATE_OP_[SHEET_NAMES.sponsorshipPackages + '|showId'] = 'UpdateSponsorshipPackagesByShowId';

const DC_BULK_DELETE_OP_ = {};
DC_BULK_DELETE_OP_[SHEET_NAMES.seasonYears + '|showId'] = 'DeleteSeasonYearsByShowId';
DC_BULK_DELETE_OP_[SHEET_NAMES.placementMenuItems + '|categoryId'] = 'DeletePlacementMenuItemsByCategoryId';
DC_BULK_DELETE_OP_[SHEET_NAMES.projectFileLinks + '|projectId'] = 'DeleteProjectFileLinksByProjectId';
DC_BULK_DELETE_OP_[SHEET_NAMES.versions + '|projectId'] = 'DeleteVersionsByProjectId';

function cascadeForeignKeySql_(sheetName, fields, foreignKeyField, oldValue, newValue) {
  const opName = DC_BULK_UPDATE_OP_[sheetName + '|' + foreignKeyField];
  if (!opName) throw new Error('No bulk update operation registered for ' + sheetName + '.' + foreignKeyField);
  executeDataConnect_(opName, { oldValue: oldValue, newValue: newValue });
}

// _deleteMany only returns a count, not the deleted rows (unlike the
// original deleteRowsByForeignKey_, which returns deleted ids so callers
// can cascade further) -- lists+filters client-side first to capture the
// ids, matching the original's return contract exactly.
function deleteRowsByForeignKeySql_(sheetName, fields, foreignKeyField, keyValue) {
  const opName = DC_BULK_DELETE_OP_[sheetName + '|' + foreignKeyField];
  if (!opName) throw new Error('No bulk delete operation registered for ' + sheetName + '.' + foreignKeyField);
  const allRows = readRowsSql_(sheetName);
  const deletedIds = allRows.filter(function (r) { return r[foreignKeyField] === keyValue; }).map(function (r) { return r.id; });
  const variables = {};
  variables[foreignKeyField] = keyValue;
  executeDataConnect_(opName, variables);
  return deletedIds;
}

// One-time manual check (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- spot-checks the 6 new functions against a few
// different entity "shapes" rather than every one of the 15: a simple
// id-keyed entity (Tag), a natural-key entity whose key can be renamed
// (HoldCo), an entity with a JSON-blob column (Version), and the bulk
// cascade path (SeasonYear deleted by foreign key). All test data is
// cleaned up at the end regardless of pass/fail.
function testSqlStorageLayer() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  // --- Tag: simple id-keyed create/read/update/delete ---
  const tagId = 'test-tag-' + Utilities.getUuid();
  appendRecordSql_(SHEET_NAMES.tags, TAG_FIELDS, { id: tagId, name: 'Test', color: '#000000', createdAt: new Date().toISOString(), createdBy: 'test' });
  let rows = readRowsSql_(SHEET_NAMES.tags);
  check('Tag created and listed', rows.some(function (r) { return r.id === tagId && r.name === 'Test'; }), true);
  const updated = updateRecordSql_(SHEET_NAMES.tags, TAG_FIELDS, 'id', tagId, { name: 'Test Renamed' });
  check('Tag update returns true (found)', updated, true);
  rows = readRowsSql_(SHEET_NAMES.tags);
  check('Tag update applied', rows.find(function (r) { return r.id === tagId; }).name, 'Test Renamed');
  const notFoundUpdate = updateRecordSql_(SHEET_NAMES.tags, TAG_FIELDS, 'id', 'does-not-exist', { name: 'x' });
  check('Update on nonexistent id returns false', notFoundUpdate, false);
  const deleted = deleteRowByKeySql_(SHEET_NAMES.tags, TAG_FIELDS, 'id', tagId);
  check('Tag delete returns true', deleted, true);
  rows = readRowsSql_(SHEET_NAMES.tags);
  check('Tag no longer listed after delete', rows.some(function (r) { return r.id === tagId; }), false);

  // --- HoldCo: natural-key entity, rename changes the key itself ---
  const holdCoName = 'Test HoldCo ' + Utilities.getUuid();
  const holdCoRenamed = holdCoName + ' Renamed';
  appendRecordSql_(SHEET_NAMES.holdCos, HOLDCO_FIELDS, { name: holdCoName });
  updateRecordSql_(SHEET_NAMES.holdCos, HOLDCO_FIELDS, 'name', holdCoName, { name: holdCoRenamed });
  rows = readRowsSql_(SHEET_NAMES.holdCos);
  check('HoldCo renamed (old name gone)', rows.some(function (r) { return r.name === holdCoName; }), false);
  check('HoldCo renamed (new name present)', rows.some(function (r) { return r.name === holdCoRenamed; }), true);
  deleteRowByKeySql_(SHEET_NAMES.holdCos, HOLDCO_FIELDS, 'name', holdCoRenamed);

  // --- Version: JSON blob field round-trips as a real object, not a string ---
  const versionId = 'test-version-' + Utilities.getUuid();
  const samplePackages = [{ title: 'Test Package', sponsorshipLineItems: [{ platform: 'Paramount+', netCost: 1000 }] }];
  appendRecordSql_(SHEET_NAMES.versions, VERSION_FIELDS, { id: versionId, projectId: 'test-project', name: 'v1', packages: samplePackages, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  rows = readRowsSql_(SHEET_NAMES.versions);
  const readBackVersion = rows.find(function (r) { return r.id === versionId; });
  check('Version.packages round-trips as a real array (not a JSON string)', Array.isArray(readBackVersion.packages) && readBackVersion.packages[0].title, 'Test Package');
  deleteRowByKeySql_(SHEET_NAMES.versions, VERSION_FIELDS, 'id', versionId);

  // --- SeasonYear: bulk delete-by-foreign-key, confirms deleted ids come back ---
  const showId = 'test-show-' + Utilities.getUuid();
  const seasonYearId = 'test-season-year-' + Utilities.getUuid();
  appendRecordSql_(SHEET_NAMES.seasonYears, SEASON_YEAR_FIELDS, { id: seasonYearId, showId: showId, name: 'Test Season' });
  const deletedIds = deleteRowsByForeignKeySql_(SHEET_NAMES.seasonYears, SEASON_YEAR_FIELDS, 'showId', showId);
  check('Bulk delete by foreign key returns the deleted id', deletedIds, [seasonYearId]);
  rows = readRowsSql_(SHEET_NAMES.seasonYears);
  check('Bulk-deleted SeasonYear no longer listed', rows.some(function (r) { return r.id === seasonYearId; }), false);

  // --- Project: bulk update-by-foreign-key cascade (e.g. an Agency rename) ---
  const oldAgency = 'Test Agency ' + Utilities.getUuid();
  const newAgency = oldAgency + ' Renamed';
  const projectId = 'test-project-' + Utilities.getUuid();
  appendRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, { id: projectId, projectName: 'Test', agency: oldAgency });
  cascadeForeignKeySql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'agency', oldAgency, newAgency);
  rows = readRowsSql_(SHEET_NAMES.projects);
  check('Bulk update cascade applied the new agency', rows.find(function (r) { return r.id === projectId; }).agency, newAgency);
  deleteRowByKeySql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'id', projectId);

  Logger.log(results.join('\n'));
  return results;
}

// One-time manual check (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- Phase 4 cutover verification for Tags. Calls
// doGet/doPost directly with a constructed event object (the most
// faithful pre-deploy test available -- exercises the real action
// dispatch, requireWrite_, and createTag_'s own validation logic, not
// just the generic SQL helpers testSqlStorageLayer already covered).
function testTagsCutover() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  const tagName = 'Cutover Test Tag ' + Utilities.getUuid();
  const tagId = Utilities.getUuid();

  doPost({ parameter: { action: 'createTag', payload: JSON.stringify({ id: tagId, name: tagName, color: '#123456' }) } });
  let list = JSON.parse(doGet({ parameter: { action: 'listTags' } }).getContent());
  check('Tag appears via doGet(listTags) after doPost(createTag)', list.some(function (t) { return t.id === tagId && t.name === tagName; }), true);

  doPost({ parameter: { action: 'updateTag', payload: JSON.stringify({ id: tagId, name: tagName, color: '#654321' }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listTags' } }).getContent());
  check('Tag color updated via doPost(updateTag)', list.find(function (t) { return t.id === tagId; }).color, '#654321');

  doPost({ parameter: { action: 'deleteTag', payload: JSON.stringify({ id: tagId }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listTags' } }).getContent());
  check('Tag gone via doGet(listTags) after doPost(deleteTag)', list.some(function (t) { return t.id === tagId; }), false);

  // Duplicate-name validation (createTag_'s own logic, not generic SQL
  // helper behavior) still works post-cutover.
  const dupName = 'Cutover Dup Test ' + Utilities.getUuid();
  doPost({ parameter: { action: 'createTag', payload: JSON.stringify({ id: Utilities.getUuid(), name: dupName }) } });
  let threw = false;
  try {
    doPost({ parameter: { action: 'createTag', payload: JSON.stringify({ id: Utilities.getUuid(), name: dupName }) } });
  } catch (e) {
    threw = true;
  }
  check('Duplicate tag name still rejected', threw, true);
  // Clean up both the original and (if somehow created) the duplicate.
  list = JSON.parse(doGet({ parameter: { action: 'listTags' } }).getContent());
  list.filter(function (t) { return t.name === dupName; }).forEach(function (t) {
    doPost({ parameter: { action: 'deleteTag', payload: JSON.stringify({ id: t.id }) } });
  });

  Logger.log(results.join('\n'));
  return results;
}

// One-time data migration (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- copies Tags' existing Sheets data into Postgres
// before/alongside the Phase 4 cutover. Caught by checking the live
// deployment right after cutover: listTags correctly returned [] from
// Postgres's actual (empty, except for our own always-cleaned-up test
// rows) state, revealing that Phase 3 (migrate existing data) needs to
// happen for an entity before Phase 4 (cut over reads to it) -- skipped
// for Tags in the rush to verify the cutover mechanism itself. Safe to
// re-run: skips any tag whose id already exists in Postgres.
function migrateTagsToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.tags);
  const existingIds = new Set(existingSql.map(function (t) { return t.id; }));
  const sheetRows = readRows_(SHEET_NAMES.tags);
  let migrated = 0, skipped = 0;
  sheetRows.forEach(function (row) {
    if (existingIds.has(row.id)) { skipped++; return; }
    appendRecordSql_(SHEET_NAMES.tags, TAG_FIELDS, row);
    migrated++;
  });
  Logger.log('Tags migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

// One-time data migration (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- copies HoldCos' existing Sheets data into
// Postgres BEFORE the cutover goes live, per the lesson learned from
// Tags (migrating after the fact briefly showed real users an empty
// list). Safe to re-run: skips any HoldCo whose name already exists in
// Postgres.
function migrateHoldCosToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.holdCos);
  const existingNames = new Set(existingSql.map(function (h) { return h.name; }));
  const sheetRows = readRows_(SHEET_NAMES.holdCos);
  let migrated = 0, skipped = 0;
  sheetRows.forEach(function (row) {
    if (existingNames.has(row.name)) { skipped++; return; }
    appendRecordSql_(SHEET_NAMES.holdCos, HOLDCO_FIELDS, row);
    migrated++;
  });
  Logger.log('HoldCos migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

// One-time manual check (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- Phase 4 cutover verification for HoldCos,
// same pattern as testTagsCutover: calls doGet/doPost directly with a
// constructed event object.
function testHoldCosCutover() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  const name = 'Cutover Test HoldCo ' + Utilities.getUuid();
  const renamed = name + ' Renamed';

  doPost({ parameter: { action: 'createHoldCo', payload: JSON.stringify({ name: name }) } });
  let list = JSON.parse(doGet({ parameter: { action: 'listHoldCos' } }).getContent());
  check('HoldCo appears via doGet(listHoldCos) after doPost(createHoldCo)', list.some(function (h) { return h.name === name; }), true);

  doPost({ parameter: { action: 'updateHoldCo', payload: JSON.stringify({ originalName: name, name: renamed }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listHoldCos' } }).getContent());
  check('HoldCo renamed via doPost(updateHoldCo)', list.some(function (h) { return h.name === renamed; }) && !list.some(function (h) { return h.name === name; }), true);

  doPost({ parameter: { action: 'deleteHoldCo', payload: JSON.stringify({ name: renamed }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listHoldCos' } }).getContent());
  check('HoldCo gone via doGet(listHoldCos) after doPost(deleteHoldCo)', list.some(function (h) { return h.name === renamed; }), false);

  Logger.log(results.join('\n'));
  return results;
}

function migratePitchTeamsToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.pitchTeams);
  const existingNames = new Set(existingSql.map(function (p) { return p.name; }));
  const sheetRows = readRows_(SHEET_NAMES.pitchTeams);
  let migrated = 0, skipped = 0;
  sheetRows.forEach(function (row) {
    if (existingNames.has(row.name)) { skipped++; return; }
    appendRecordSql_(SHEET_NAMES.pitchTeams, PITCH_TEAM_FIELDS, row);
    migrated++;
  });
  Logger.log('PitchTeams migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

function testPitchTeamsCutover() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  const name = 'Cutover Test PitchTeam ' + Utilities.getUuid();
  const renamed = name + ' Renamed';

  doPost({ parameter: { action: 'createPitchTeam', payload: JSON.stringify({ name: name }) } });
  let list = JSON.parse(doGet({ parameter: { action: 'listPitchTeams' } }).getContent());
  check('PitchTeam appears via doGet(listPitchTeams) after doPost(createPitchTeam)', list.some(function (p) { return p.name === name; }), true);

  doPost({ parameter: { action: 'updatePitchTeam', payload: JSON.stringify({ originalName: name, name: renamed }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listPitchTeams' } }).getContent());
  check('PitchTeam renamed via doPost(updatePitchTeam)', list.some(function (p) { return p.name === renamed; }) && !list.some(function (p) { return p.name === name; }), true);

  doPost({ parameter: { action: 'deletePitchTeam', payload: JSON.stringify({ name: renamed }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listPitchTeams' } }).getContent());
  check('PitchTeam gone via doGet(listPitchTeams) after doPost(deletePitchTeam)', list.some(function (p) { return p.name === renamed; }), false);

  Logger.log(results.join('\n'));
  return results;
}

function migrateTentpoleShowsToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.tentpoleShows);
  const existingIds = new Set(existingSql.map(function (s) { return s.id; }));
  const sheetRows = readRows_(SHEET_NAMES.tentpoleShows);
  let migrated = 0, skipped = 0;
  sheetRows.forEach(function (row) {
    if (existingIds.has(row.id)) { skipped++; return; }
    appendRecordSql_(SHEET_NAMES.tentpoleShows, TENTPOLE_SHOW_FIELDS, row);
    migrated++;
  });
  Logger.log('TentpoleShows migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

function testTentpoleShowsCutover() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  const id = Utilities.getUuid();
  const name = 'Cutover Test Show ' + id;

  doPost({ parameter: { action: 'createTentpoleShow', payload: JSON.stringify({ id: id, name: name }) } });
  let list = JSON.parse(doGet({ parameter: { action: 'listTentpoleShows' } }).getContent());
  check('Show appears via doGet(listTentpoleShows) after doPost(createTentpoleShow)', list.some(function (s) { return s.id === id && s.name === name; }), true);

  doPost({ parameter: { action: 'updateTentpoleShow', payload: JSON.stringify({ id: id, name: name + ' Renamed' }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listTentpoleShows' } }).getContent());
  check('Show renamed via doPost(updateTentpoleShow)', list.find(function (s) { return s.id === id; }).name, name + ' Renamed');

  doPost({ parameter: { action: 'deleteTentpoleShow', payload: JSON.stringify({ id: id }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listTentpoleShows' } }).getContent());
  check('Show gone via doGet(listTentpoleShows) after doPost(deleteTentpoleShow)', list.some(function (s) { return s.id === id; }), false);

  Logger.log(results.join('\n'));
  return results;
}

function migrateAgencyHoldCoToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.agencyHoldCo);
  const existingAgencies = new Set(existingSql.map(function (a) { return a.agency; }));
  const sheetRows = readRows_(SHEET_NAMES.agencyHoldCo);
  let migrated = 0, skipped = 0;
  // The sheet itself never enforced uniqueness on `agency` the way Postgres's
  // primary key does, so this also guards against duplicate rows *within*
  // the sheet, not just rows already migrated in a prior run -- adding to
  // the Set as we go (not just computing it once upfront) is what catches that.
  sheetRows.forEach(function (row) {
    if (existingAgencies.has(row.agency)) { skipped++; return; }
    appendRecordSql_(SHEET_NAMES.agencyHoldCo, AGENCY_HOLDCO_FIELDS, row);
    existingAgencies.add(row.agency);
    migrated++;
  });
  Logger.log('AgencyHoldCo migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

// One-time manual check (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- Phase 4 cutover verification for AgencyHoldCo,
// same pattern as testHoldCosCutover. Also exercises the holdCo-rename
// cascade (now SQL-backed via cascadeForeignKeySql_ in updateHoldCo) to
// confirm AgencyHoldCo rows referencing a renamed HoldCo get updated too.
function testAgencyHoldCoCutover() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  const agency = 'Cutover Test Agency ' + Utilities.getUuid();
  const renamed = agency + ' Renamed';
  const holdCoName = 'Cutover Test HoldCo ' + Utilities.getUuid();
  const holdCoRenamed = holdCoName + ' Renamed';

  doPost({ parameter: { action: 'createAgencyHoldCoEntry', payload: JSON.stringify({ agency: agency, holdCo: '' }) } });
  let list = JSON.parse(doGet({ parameter: { action: 'listAgencyHoldCo' } }).getContent());
  check('Agency appears via doGet(listAgencyHoldCo) after doPost(createAgencyHoldCoEntry)', list.some(function (a) { return a.agency === agency; }), true);

  doPost({ parameter: { action: 'updateAgencyHoldCoEntry', payload: JSON.stringify({ agency: agency, holdCo: 'TEST HOLDCO' } ) } });
  list = JSON.parse(doGet({ parameter: { action: 'listAgencyHoldCo' } }).getContent());
  check('Agency holdCo updated via doPost(updateAgencyHoldCoEntry)', list.find(function (a) { return a.agency === agency; }).holdCo, 'TEST HOLDCO');

  doPost({ parameter: { action: 'renameAgency', payload: JSON.stringify({ originalName: agency, name: renamed }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listAgencyHoldCo' } }).getContent());
  check('Agency renamed via doPost(renameAgency)', list.some(function (a) { return a.agency === renamed; }) && !list.some(function (a) { return a.agency === agency; }), true);

  doPost({ parameter: { action: 'createHoldCo', payload: JSON.stringify({ name: holdCoName } ) } });
  doPost({ parameter: { action: 'updateAgencyHoldCoEntry', payload: JSON.stringify({ agency: renamed, holdCo: holdCoName }) } });
  doPost({ parameter: { action: 'updateHoldCo', payload: JSON.stringify({ originalName: holdCoName, name: holdCoRenamed }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listAgencyHoldCo' } }).getContent());
  check('Agency holdCo cascaded via doPost(updateHoldCo) rename', list.find(function (a) { return a.agency === renamed; }).holdCo, holdCoRenamed);

  doPost({ parameter: { action: 'deleteHoldCo', payload: JSON.stringify({ name: holdCoRenamed } ) } });
  list = JSON.parse(doGet({ parameter: { action: 'listAgencyHoldCo' } }).getContent());
  check('Agency holdCo cleared via doPost(deleteHoldCo) cascade', list.find(function (a) { return a.agency === renamed; }).holdCo, '');

  doPost({ parameter: { action: 'deleteAgencyHoldCoEntry', payload: JSON.stringify({ agency: renamed }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listAgencyHoldCo' } }).getContent());
  check('Agency gone via doGet(listAgencyHoldCo) after doPost(deleteAgencyHoldCoEntry)', list.some(function (a) { return a.agency === renamed; }), false);

  Logger.log(results.join('\n'));
  return results;
}

// Diagnostic for the 2026-10-08 AgencyHoldCo cutover test failure -- checks
// whether ListAgencyHoldCo's generated query is silently capping row count
// (the table now has ~1069 rows post-migration, unlike every other entity
// cut over so far, which had under 10 -- a default page-size limit on the
// generated list resolver would explain a freshly-inserted row not showing
// up in doGet(listAgencyHoldCo)'s results).
function diagnoseAgencyHoldCoListSize() {
  const rows = readRowsSql_(SHEET_NAMES.agencyHoldCo);
  Logger.log('readRowsSql_(agencyHoldCo) returned ' + rows.length + ' rows');
}

function migrateTeamRosterToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.teamRoster);
  const existingNames = new Set(existingSql.map(function (r) { return r.teamMemberName; }));
  const sheetRows = readRows_(SHEET_NAMES.teamRoster);
  let migrated = 0, skipped = 0;
  sheetRows.forEach(function (row) {
    if (existingNames.has(row.teamMemberName)) { skipped++; return; }
    appendRecordSql_(SHEET_NAMES.teamRoster, TEAM_ROSTER_FIELDS, row);
    existingNames.add(row.teamMemberName);
    migrated++;
  });
  Logger.log('TeamRoster migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

// One-time manual check (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- Phase 4 cutover verification for TeamRoster,
// same pattern as testAgencyHoldCoCutover. Also exercises the pitchTeam-
// rename cascade (now SQL-backed via cascadeForeignKeySql_ in
// updatePitchTeam) to confirm TeamRoster rows referencing a renamed
// PitchTeam get updated too.
function testTeamRosterCutover() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  const memberName = 'Cutover Test Member ' + Utilities.getUuid();
  const pitchTeamName = 'Cutover Test PitchTeam ' + Utilities.getUuid();
  const pitchTeamRenamed = pitchTeamName + ' Renamed';

  doPost({ parameter: { action: 'createTeamRosterEntry', payload: JSON.stringify({ teamMemberName: memberName, pitchTeam: '' }) } });
  let list = JSON.parse(doGet({ parameter: { action: 'listTeamRoster' } }).getContent());
  check('Member appears via doGet(listTeamRoster) after doPost(createTeamRosterEntry)', list.some(function (r) { return r.teamMemberName === memberName; }), true);

  doPost({ parameter: { action: 'createPitchTeam', payload: JSON.stringify({ name: pitchTeamName }) } });
  doPost({ parameter: { action: 'updateTeamRosterEntry', payload: JSON.stringify({ teamMemberName: memberName, pitchTeam: pitchTeamName }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listTeamRoster' } }).getContent());
  check('Member pitchTeam updated via doPost(updateTeamRosterEntry)', list.find(function (r) { return r.teamMemberName === memberName; }).pitchTeam, pitchTeamName);

  doPost({ parameter: { action: 'updatePitchTeam', payload: JSON.stringify({ originalName: pitchTeamName, name: pitchTeamRenamed }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listTeamRoster' } }).getContent());
  check('Member pitchTeam cascaded via doPost(updatePitchTeam) rename', list.find(function (r) { return r.teamMemberName === memberName; }).pitchTeam, pitchTeamRenamed);

  doPost({ parameter: { action: 'deletePitchTeam', payload: JSON.stringify({ name: pitchTeamRenamed }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listTeamRoster' } }).getContent());
  check('Member pitchTeam cleared via doPost(deletePitchTeam) cascade', list.find(function (r) { return r.teamMemberName === memberName; }).pitchTeam, '');

  doPost({ parameter: { action: 'deleteTeamRosterEntry', payload: JSON.stringify({ teamMemberName: memberName }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listTeamRoster' } }).getContent());
  check('Member gone via doGet(listTeamRoster) after doPost(deleteTeamRosterEntry)', list.some(function (r) { return r.teamMemberName === memberName; }), false);

  Logger.log(results.join('\n'));
  return results;
}

function migrateSeasonYearsToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.seasonYears);
  const existingIds = new Set(existingSql.map(function (s) { return s.id; }));
  const sheetRows = readRows_(SHEET_NAMES.seasonYears);
  let migrated = 0, skipped = 0;
  sheetRows.forEach(function (row) {
    if (existingIds.has(row.id)) { skipped++; return; }
    // Sheets stores season-year names like "2026" as a Number cell, not
    // text, so getValues() hands back a JS number here -- GraphQL's String
    // type rejects that outright (confirmed 2026-10-08: "$name is invalid
    // String: unexpected value: 2026 with type: float64"), so coerce it.
    appendRecordSql_(SHEET_NAMES.seasonYears, SEASON_YEAR_FIELDS, Object.assign({}, row, { name: String(row.name) }));
    existingIds.add(row.id);
    migrated++;
  });
  Logger.log('SeasonYears migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

// One-time manual check (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- Phase 4 cutover verification for SeasonYears.
// Also exercises deleteTentpoleShow's bulk-delete cascade into
// SeasonYears (now SQL-backed via deleteRowsByForeignKeySql_) to confirm
// a Show's child SeasonYears rows are actually removed when the Show is
// deleted.
function testSeasonYearsCutover() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  const id = Utilities.getUuid();
  const name = 'Cutover Test SeasonYear ' + id;

  doPost({ parameter: { action: 'createSeasonYear', payload: JSON.stringify({ id: id, showId: '', name: name }) } });
  let list = JSON.parse(doGet({ parameter: { action: 'listSeasonYears' } }).getContent());
  check('SeasonYear appears via doGet(listSeasonYears) after doPost(createSeasonYear)', list.some(function (s) { return s.id === id; }), true);

  doPost({ parameter: { action: 'updateSeasonYear', payload: JSON.stringify({ id: id, name: name + ' Renamed' }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listSeasonYears' } }).getContent());
  check('SeasonYear renamed via doPost(updateSeasonYear)', list.find(function (s) { return s.id === id; }).name, name + ' Renamed');

  doPost({ parameter: { action: 'deleteSeasonYear', payload: JSON.stringify({ id: id }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listSeasonYears' } }).getContent());
  check('SeasonYear gone via doGet(listSeasonYears) after doPost(deleteSeasonYear)', list.some(function (s) { return s.id === id; }), false);

  const showId = Utilities.getUuid();
  const showName = 'Cutover Test Show ' + showId;
  const childId = Utilities.getUuid();
  doPost({ parameter: { action: 'createTentpoleShow', payload: JSON.stringify({ id: showId, name: showName }) } });
  doPost({ parameter: { action: 'createSeasonYear', payload: JSON.stringify({ id: childId, showId: showId, name: 'Child Season' }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listSeasonYears' } }).getContent());
  check('Child SeasonYear appears before Show deletion', list.some(function (s) { return s.id === childId; }), true);

  doPost({ parameter: { action: 'deleteTentpoleShow', payload: JSON.stringify({ id: showId }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listSeasonYears' } }).getContent());
  check('Child SeasonYear bulk-deleted via doPost(deleteTentpoleShow) cascade', list.some(function (s) { return s.id === childId; }), false);

  Logger.log(results.join('\n'));
  return results;
}

function migratePlacementCategoriesToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.placementCategories);
  const existingIds = new Set(existingSql.map(function (c) { return c.id; }));
  const sheetRows = readRows_(SHEET_NAMES.placementCategories);
  let migrated = 0, skipped = 0;
  sheetRows.forEach(function (row) {
    if (existingIds.has(row.id)) { skipped++; return; }
    appendRecordSql_(SHEET_NAMES.placementCategories, PLACEMENT_CATEGORY_FIELDS, row);
    existingIds.add(row.id);
    migrated++;
  });
  Logger.log('PlacementCategories migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

function migratePlacementMenuItemsToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.placementMenuItems);
  const existingIds = new Set(existingSql.map(function (m) { return m.id; }));
  const sheetRows = readRows_(SHEET_NAMES.placementMenuItems);
  let migrated = 0, skipped = 0;
  sheetRows.forEach(function (row) {
    if (existingIds.has(row.id)) { skipped++; return; }
    appendRecordSql_(SHEET_NAMES.placementMenuItems, PLACEMENT_MENU_ITEM_FIELDS, row);
    existingIds.add(row.id);
    migrated++;
  });
  Logger.log('PlacementMenuItems migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

// One-time manual check (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- Phase 4 cutover verification for
// PlacementCategories + PlacementMenuItems together, since they share a
// cascade (deletePlacementCategory bulk-deletes its child menu items,
// now SQL-backed via deleteRowsByForeignKeySql_). Also exercises the
// 'lines' JSON_FIELDS blob round-tripping as a real array, same pattern
// as Version's 'packages' in testSqlStorageLayer.
function testPlacementCategoriesAndMenuItemsCutover() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  const catId = Utilities.getUuid();
  const catName = 'Cutover Test Category ' + catId;

  doPost({ parameter: { action: 'createPlacementCategory', payload: JSON.stringify({ id: catId, name: catName, placementType: 'digital' }) } });
  let cats = JSON.parse(doGet({ parameter: { action: 'listPlacementCategories' } }).getContent());
  check('Category appears via doGet(listPlacementCategories) after doPost(createPlacementCategory)', cats.some(function (c) { return c.id === catId; }), true);

  doPost({ parameter: { action: 'updatePlacementCategory', payload: JSON.stringify({ id: catId, name: catName + ' Renamed', placementType: 'digital' }) } });
  cats = JSON.parse(doGet({ parameter: { action: 'listPlacementCategories' } }).getContent());
  check('Category renamed via doPost(updatePlacementCategory)', cats.find(function (c) { return c.id === catId; }).name, catName + ' Renamed');

  const itemId = Utilities.getUuid();
  const itemName = 'Cutover Test MenuItem ' + itemId;
  const lines = [{ label: 'Line 1', rate: 100 }];

  doPost({ parameter: { action: 'createPlacementMenuItem', payload: JSON.stringify({ id: itemId, categoryId: catId, name: itemName, rateMode: 'flat', lines: lines }) } });
  let items = JSON.parse(doGet({ parameter: { action: 'listPlacementMenuItems' } }).getContent());
  check('MenuItem appears via doGet(listPlacementMenuItems) after doPost(createPlacementMenuItem)', items.some(function (m) { return m.id === itemId; }), true);
  check('MenuItem lines round-trips as a real array', items.find(function (m) { return m.id === itemId; }).lines, lines);

  doPost({ parameter: { action: 'updatePlacementMenuItem', payload: JSON.stringify({ id: itemId, name: itemName + ' Renamed' }) } });
  items = JSON.parse(doGet({ parameter: { action: 'listPlacementMenuItems' } }).getContent());
  check('MenuItem renamed via doPost(updatePlacementMenuItem)', items.find(function (m) { return m.id === itemId; }).name, itemName + ' Renamed');

  doPost({ parameter: { action: 'deletePlacementCategory', payload: JSON.stringify({ id: catId }) } });
  cats = JSON.parse(doGet({ parameter: { action: 'listPlacementCategories' } }).getContent());
  check('Category gone via doGet(listPlacementCategories) after doPost(deletePlacementCategory)', cats.some(function (c) { return c.id === catId; }), false);
  items = JSON.parse(doGet({ parameter: { action: 'listPlacementMenuItems' } }).getContent());
  check('MenuItem bulk-deleted via doPost(deletePlacementCategory) cascade', items.some(function (m) { return m.id === itemId; }), false);

  Logger.log(results.join('\n'));
  return results;
}

function migrateUsersToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.users);
  const existingEmails = new Set(existingSql.map(function (u) { return u.email; }));
  const sheetRows = readRows_(SHEET_NAMES.users);
  let migrated = 0, skipped = 0;
  sheetRows.forEach(function (row) {
    if (existingEmails.has(row.email)) { skipped++; return; }
    appendRecordSql_(SHEET_NAMES.users, USER_FIELDS, row);
    existingEmails.add(row.email);
    migrated++;
  });
  Logger.log('Users migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

// One-time manual check (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- Phase 4 cutover verification for Users. This is
// the highest-stakes entity cut over so far: getCurrentUser_ (called on
// every doGet/doPost) now reads from SQL, so if the real admin row wasn't
// migrated first, every write action -- including this test's own
// doPost calls -- would fail requireWrite_ with "Write access required".
// Uses synthetic emails throughout and never touches the real signed-in
// user's own row.
function testUsersCutover() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  const whoami = JSON.parse(doGet({ parameter: { action: 'whoami' } }).getContent());
  check('Real signed-in user still resolves with write role via doGet(whoami)', whoami.role, 'write');

  const email = 'cutover-test-' + Utilities.getUuid() + '@example.com';
  const name = 'Cutover Test User';

  doPost({ parameter: { action: 'createUser', payload: JSON.stringify({ email: email, name: name, role: 'read', slackUserId: '' }) } });
  let list = JSON.parse(doGet({ parameter: { action: 'listUsers' } }).getContent());
  check('User appears via doGet(listUsers) after doPost(createUser)', list.some(function (u) { return u.email === email; }), true);

  doPost({ parameter: { action: 'updateUser', payload: JSON.stringify({ originalEmail: email, email: email, name: name + ' Renamed', role: 'write' }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listUsers' } }).getContent());
  check('User renamed+role updated via doPost(updateUser)', list.find(function (u) { return u.email === email; }).name + '|' + list.find(function (u) { return u.email === email; }).role, name + ' Renamed|write');

  doPost({ parameter: { action: 'deleteUser', payload: JSON.stringify({ email: email }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listUsers' } }).getContent());
  check('User gone via doGet(listUsers) after doPost(deleteUser)', list.some(function (u) { return u.email === email; }), false);

  Logger.log(results.join('\n'));
  return results;
}

function migrateProjectFileLinksToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.projectFileLinks);
  const existingIds = new Set(existingSql.map(function (l) { return l.id; }));
  const sheetRows = readRows_(SHEET_NAMES.projectFileLinks);
  let migrated = 0, skipped = 0;
  sheetRows.forEach(function (row) {
    if (existingIds.has(row.id)) { skipped++; return; }
    appendRecordSql_(SHEET_NAMES.projectFileLinks, PROJECT_FILE_LINK_FIELDS, row);
    existingIds.add(row.id);
    migrated++;
  });
  Logger.log('ProjectFileLinks migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

// One-time manual check (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- Phase 4 cutover verification for ProjectFileLinks.
// Also exercises deleteProject_'s cascade (now SQL-backed via
// deleteRowsByForeignKeySql_) -- but calls deleteProject_ directly rather
// than doPost({action:'deleteProject'}), and appends the test Project row
// straight to the Sheet via appendRecord_, both to avoid the real
// createProject/deleteProject action handlers' side effects (Drive folder
// creation via createProjectFolder_), which don't belong in a storage-
// layer cutover test. Projects itself isn't cut over yet, so this test
// Project row lives only in Sheets, same as real ones today.
function testProjectFileLinksCutover() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  const projectId = 'cutover-test-project-' + Utilities.getUuid();
  // Projects is SQL-backed now (it wasn't yet when this test was first
  // written) -- appendRecordSql_ here, not appendRecord_, so this fixture
  // row lives in the same store deleteProject_ actually deletes from below.
  appendRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, { id: projectId, projectName: 'Cutover Test Project' });

  const linkId = Utilities.getUuid();
  doPost({ parameter: { action: 'addProjectFileLink', payload: JSON.stringify({ id: linkId, projectId: projectId, name: 'Test Link', url: 'https://example.com' }) } });
  let list = JSON.parse(doGet({ parameter: { action: 'listProjectFileLinks', projectId: projectId } }).getContent());
  check('Link appears via doGet(listProjectFileLinks) after doPost(addProjectFileLink)', list.some(function (l) { return l.id === linkId; }), true);

  const linkId2 = Utilities.getUuid();
  doPost({ parameter: { action: 'addProjectFileLink', payload: JSON.stringify({ id: linkId2, projectId: projectId, name: 'Test Link 2', url: 'https://example.com/2' }) } });
  doPost({ parameter: { action: 'deleteProjectFileLink', payload: JSON.stringify({ id: linkId2 }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listProjectFileLinks', projectId: projectId } }).getContent());
  check('Link gone via doGet(listProjectFileLinks) after doPost(deleteProjectFileLink)', list.some(function (l) { return l.id === linkId2; }), false);

  deleteProject_(projectId);
  list = JSON.parse(doGet({ parameter: { action: 'listProjectFileLinks', projectId: projectId } }).getContent());
  check('Remaining link bulk-deleted via deleteProject_ cascade', list.some(function (l) { return l.id === linkId; }), false);

  Logger.log(results.join('\n'));
  return results;
}

// Only these two are genuinely numeric (GraphQL Float) -- every other
// CLOSED_DEAL_FIELDS column is a String, but Sheets stores anything
// number-looking (e.g. a bare project_id like 1784050079976) as a JS
// number, same root cause as SeasonYear's 'name' (confirmed 2026-10-08:
// "$projectId is invalid String: unexpected value: ... with type: float64").
const CLOSED_DEAL_NUMERIC_FIELDS_ = ['total_investment', 'total_margin_percent'];

function migrateClosedDealsToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.closedDeals);
  const existingIds = new Set(existingSql.map(function (d) { return d.deal_id; }));
  const sheetRows = readRows_(SHEET_NAMES.closedDeals);
  let migrated = 0, skipped = 0;
  sheetRows.forEach(function (row) {
    if (existingIds.has(row.deal_id)) { skipped++; return; }
    const coerced = {};
    CLOSED_DEAL_FIELDS.forEach(function (f) {
      const v = row[f];
      coerced[f] = (typeof v === 'number' && !CLOSED_DEAL_NUMERIC_FIELDS_.includes(f)) ? String(v) : v;
    });
    appendRecordSql_(SHEET_NAMES.closedDeals, CLOSED_DEAL_FIELDS, coerced);
    existingIds.add(row.deal_id);
    migrated++;
  });
  Logger.log('ClosedDeals migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

// One-time manual check (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- Phase 4 cutover verification for ClosedDeals,
// the last entity in this batch and the only one with a fieldMap (snake_case
// Code.gs fields vs. camelCase GraphQL variables). Also caught and fixed a
// real bug here: deleteRowByKeySql_ wasn't applying entity.fieldMap to the
// key field, so DeleteClosedDeal would have been sent the wrong variable
// name ('deal_id' instead of the required 'dealId'). Exercises upsertClosedDeal's
// both branches (insert when not found, update in place when found) and
// the 'snapshot' JSON_FIELDS blob round-tripping as a real object.
function testClosedDealsCutover() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  const dealId = 'cutover-test-deal-' + Utilities.getUuid();
  const snapshot = { lines: [{ label: 'Line 1' }] };

  doPost({ parameter: { action: 'upsertClosedDeal', payload: JSON.stringify({ deal_id: dealId, project_name: 'Cutover Test Project', deal_status: 'closed', snapshot: snapshot }) } });
  let list = JSON.parse(doGet({ parameter: { action: 'listClosedDeals' } }).getContent());
  check('Deal appears via doGet(listClosedDeals) after doPost(upsertClosedDeal) insert branch', list.some(function (d) { return d.deal_id === dealId; }), true);
  check('Deal snapshot round-trips as a real object', list.find(function (d) { return d.deal_id === dealId; }).snapshot, snapshot);

  doPost({ parameter: { action: 'upsertClosedDeal', payload: JSON.stringify({ deal_id: dealId, project_name: 'Cutover Test Project Renamed', deal_status: 'closed', snapshot: snapshot }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listClosedDeals' } }).getContent());
  check('Deal updated in place via doPost(upsertClosedDeal) update branch', list.find(function (d) { return d.deal_id === dealId; }).project_name, 'Cutover Test Project Renamed');
  check('Still exactly one row for this deal_id (no duplicate insert)', list.filter(function (d) { return d.deal_id === dealId; }).length, 1);

  doPost({ parameter: { action: 'deleteClosedDeal', payload: JSON.stringify({ deal_id: dealId }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listClosedDeals' } }).getContent());
  check('Deal gone via doGet(listClosedDeals) after doPost(deleteClosedDeal)', list.some(function (d) { return d.deal_id === dealId; }), false);

  Logger.log(results.join('\n'));
  return results;
}

// rushRequest is a GraphQL Boolean, but Sheets checkbox-less cells can hold
// almost anything ("", "Yes", "FALSE", a real boolean) -- coerce defensively
// rather than wait for a live error like the SeasonYear/ClosedDeal numeric
// coercion bugs. Every other PROJECT_FIELDS column is a String (or a Date/
// Timestamp that's already proven to round-trip as an ISO string elsewhere).
function coerceProjectRowForSql_(row) {
  const out = Object.assign({}, row);
  const v = out.rushRequest;
  out.rushRequest = (typeof v === 'boolean') ? v : (typeof v === 'string' ? /^(true|yes)$/i.test(v.trim()) : !!v);
  return out;
}

function migrateProjectsToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.projects);
  const existingIds = new Set(existingSql.map(function (p) { return p.id; }));
  const sheetRows = readRows_(SHEET_NAMES.projects);
  let migrated = 0, skipped = 0;
  sheetRows.forEach(function (row) {
    if (existingIds.has(row.id)) { skipped++; return; }
    appendRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, coerceProjectRowForSql_(row));
    existingIds.add(row.id);
    migrated++;
  });
  Logger.log('Projects migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

// One-time manual check (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- Phase 4 cutover verification for Projects, the
// first of the high-stakes final batch. Two groups of checks:
//
// 1. Storage-layer checks (list/update/delete, plus every cascade INTO
//    Projects: deleteTag_, renameAgency, deleteTentpoleShow,
//    deleteSeasonYear) using a project row seeded directly via
//    appendRecordSql_ -- bypassing the real createProject business logic
//    (applyProjectLookups_, createProjectFolder_) since those aren't part
//    of this migration and createProjectFolder_ has a real side effect
//    (creates an actual Drive folder).
// 2. One single real doPost({action:'createProject'}) call, to confirm the
//    full live path (lookups + Drive folder creation + SQL write) still
//    works end to end -- then deleteProject_ removes the DB rows
//    immediately after, but per deleteProject_'s own design it deliberately
//    does NOT delete the real Drive folder it just created. That folder
//    (named "Debug - Debug - ZZZ_DELETE_ME Cutover Test Project", inside
//    the current year's subfolder of the shared project-folders Drive) is
//    harmless but real -- feel free to delete it manually afterward.
function testProjectsCutover() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  const projectId = 'cutover-test-project-' + Utilities.getUuid();
  appendRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, { id: projectId, projectName: 'Cutover Test Project', agency: 'Cutover Test Agency Untouched', tags: 'Alpha,Beta' });
  let list = JSON.parse(doGet({ parameter: { action: 'listProjects' } }).getContent());
  check('Project appears via doGet(listProjects) after appendRecordSql_', list.some(function (p) { return p.id === projectId; }), true);

  // Confirmed 2026-10-16 bug: the web form sends untouched date inputs as
  // "", which Postgres's Date type rejected, failing the whole create.
  const blankDatesId = 'cutover-test-project-' + Utilities.getUuid();
  appendRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, { id: blankDatesId, projectName: 'Blank Dates Test', planRequestDate: '', planDueDate: '', campaignStartDate: '', campaignEndDate: '' });
  updateRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'id', blankDatesId, { id: blankDatesId, planDueDate: '2026-11-01' });
  updateRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'id', blankDatesId, { id: blankDatesId, planDueDate: '' });
  list = JSON.parse(doGet({ parameter: { action: 'listProjects' } }).getContent());
  const blankDates = list.find(function (p) { return p.id === blankDatesId; });
  check('Project with blank dates is created (blank dates sent as null)', !!blankDates, true);
  check('Project date cleared back to blank via update', blankDates ? !blankDates.planDueDate : null, true);
  deleteRowByKeySql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'id', blankDatesId);

  doPost({ parameter: { action: 'updateProject', payload: JSON.stringify({ id: projectId, projectName: 'Cutover Test Project Renamed' }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listProjects' } }).getContent());
  check('Project renamed via doPost(updateProject)', list.find(function (p) { return p.id === projectId; }).projectName, 'Cutover Test Project Renamed');

  // deleteTag_'s cascade -- strips one tag out of the comma-separated list.
  const tagId = Utilities.getUuid();
  const tagName = 'Cutover Test Tag ' + tagId;
  appendRecordSql_(SHEET_NAMES.tags, TAG_FIELDS, { id: tagId, name: tagName, color: '#000000' });
  updateRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'id', projectId, { id: projectId, tags: 'Alpha,' + tagName + ',Beta' });
  deleteTag_(tagId);
  list = JSON.parse(doGet({ parameter: { action: 'listProjects' } }).getContent());
  check('Project tags cascaded via deleteTag_ (tag stripped, others kept)', list.find(function (p) { return p.id === projectId; }).tags, 'Alpha,Beta');

  // renameAgency's cascade -- blanket field replace via cascadeForeignKeySql_.
  const agency = 'Cutover Test Agency ' + Utilities.getUuid();
  const agencyRenamed = agency + ' Renamed';
  updateRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'id', projectId, { id: projectId, agency: agency });
  doPost({ parameter: { action: 'createAgencyHoldCoEntry', payload: JSON.stringify({ agency: agency, holdCo: '' }) } });
  doPost({ parameter: { action: 'renameAgency', payload: JSON.stringify({ originalName: agency, name: agencyRenamed }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listProjects' } }).getContent());
  check('Project agency cascaded via doPost(renameAgency)', list.find(function (p) { return p.id === projectId; }).agency, agencyRenamed);
  doPost({ parameter: { action: 'deleteAgencyHoldCoEntry', payload: JSON.stringify({ agency: agencyRenamed }) } });

  // deleteTentpoleShow's and deleteSeasonYear's cascades -- field cleared to ''.
  const showId = Utilities.getUuid();
  const seasonYearId = Utilities.getUuid();
  doPost({ parameter: { action: 'createTentpoleShow', payload: JSON.stringify({ id: showId, name: 'Cutover Test Show ' + showId }) } });
  updateRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'id', projectId, { id: projectId, tentpoleShowId: showId });
  doPost({ parameter: { action: 'deleteTentpoleShow', payload: JSON.stringify({ id: showId }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listProjects' } }).getContent());
  check('Project tentpoleShowId cleared via doPost(deleteTentpoleShow)', list.find(function (p) { return p.id === projectId; }).tentpoleShowId, '');

  doPost({ parameter: { action: 'createSeasonYear', payload: JSON.stringify({ id: seasonYearId, showId: '', name: 'Cutover Test Season' }) } });
  updateRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, 'id', projectId, { id: projectId, seasonYearId: seasonYearId });
  doPost({ parameter: { action: 'deleteSeasonYear', payload: JSON.stringify({ id: seasonYearId }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listProjects' } }).getContent());
  check('Project seasonYearId cleared via doPost(deleteSeasonYear)', list.find(function (p) { return p.id === projectId; }).seasonYearId, '');

  deleteProject_(projectId);
  list = JSON.parse(doGet({ parameter: { action: 'listProjects' } }).getContent());
  check('Project gone via doGet(listProjects) after deleteProject_', list.some(function (p) { return p.id === projectId; }), false);

  // Real end-to-end check of the actual createProject action -- see this
  // function's header comment re: the real Drive folder this leaves behind.
  const liveProjectId = Utilities.getUuid();
  doPost({ parameter: { action: 'createProject', payload: JSON.stringify({ id: liveProjectId, account: 'Debug', brand: 'Debug', projectName: 'ZZZ_DELETE_ME Cutover Test Project' }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listProjects' } }).getContent());
  const liveProject = list.find(function (p) { return p.id === liveProjectId; });
  check('Real createProject action writes to SQL and gets a Drive folder', !!(liveProject && liveProject.folderId), true);
  deleteProject_(liveProjectId);

  Logger.log(results.join('\n'));
  return results;
}

function migrateVersionsToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.versions);
  const existingIds = new Set(existingSql.map(function (v) { return v.id; }));
  const sheetRows = readRows_(SHEET_NAMES.versions);
  let migrated = 0, skipped = 0;
  sheetRows.forEach(function (row) {
    if (existingIds.has(row.id)) { skipped++; return; }
    appendRecordSql_(SHEET_NAMES.versions, VERSION_FIELDS, row);
    existingIds.add(row.id);
    migrated++;
  });
  Logger.log('Versions migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

// One-time manual check (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- Phase 4 cutover verification for Versions.
// Also exercises deleteProject_'s bulk-delete cascade into Versions (now
// SQL-backed via deleteRowsByForeignKeySql_, same as ProjectFileLinks),
// and 'packages' JSON_FIELDS blob round-tripping as a real array.
function testVersionsCutover() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  const projectId = 'cutover-test-project-' + Utilities.getUuid();
  appendRecordSql_(SHEET_NAMES.projects, PROJECT_FIELDS, { id: projectId, projectName: 'Cutover Test Project' });

  const versionId = Utilities.getUuid();
  const packages = [{ title: 'Test Package', investment: 1000 }];
  doPost({ parameter: { action: 'createVersion', payload: JSON.stringify({ id: versionId, projectId: projectId, name: 'v1', packages: packages }) } });
  let list = JSON.parse(doGet({ parameter: { action: 'listVersions' } }).getContent());
  check('Version appears via doGet(listVersions) after doPost(createVersion)', list.some(function (v) { return v.id === versionId; }), true);
  check('Version packages round-trips as a real array', list.find(function (v) { return v.id === versionId; }).packages, packages);

  doPost({ parameter: { action: 'updateVersion', payload: JSON.stringify({ id: versionId, name: 'v1 Renamed' }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listVersions' } }).getContent());
  check('Version renamed via doPost(updateVersion)', list.find(function (v) { return v.id === versionId; }).name, 'v1 Renamed');

  // Confirmed 2026-10-28 bug: Mark Complete sent a full ISO timestamp,
  // which the Date column rejected.
  doPost({ parameter: { action: 'updateVersion', payload: JSON.stringify({ id: versionId, completedDate: '2026-10-28T19:04:11.123Z' }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listVersions' } }).getContent());
  check('Version completedDate sent as a full timestamp saves as its day', list.find(function (v) { return v.id === versionId; }).completedDate, '2026-10-28');

  const versionId2 = Utilities.getUuid();
  doPost({ parameter: { action: 'createVersion', payload: JSON.stringify({ id: versionId2, projectId: projectId, name: 'v2' }) } });
  doPost({ parameter: { action: 'deleteVersion', payload: JSON.stringify({ id: versionId2 }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listVersions' } }).getContent());
  check('Version gone via doGet(listVersions) after doPost(deleteVersion)', list.some(function (v) { return v.id === versionId2; }), false);

  deleteProject_(projectId);
  list = JSON.parse(doGet({ parameter: { action: 'listVersions' } }).getContent());
  check('Remaining version bulk-deleted via deleteProject_ cascade', list.some(function (v) { return v.id === versionId; }), false);

  Logger.log(results.join('\n'));
  return results;
}

function migrateSponsorshipPackagesToSql() {
  const existingSql = readRowsSql_(SHEET_NAMES.sponsorshipPackages);
  const existingIds = new Set(existingSql.map(function (p) { return p.id; }));
  const sheetRows = readRows_(SHEET_NAMES.sponsorshipPackages);
  let migrated = 0, skipped = 0;
  sheetRows.forEach(function (row) {
    if (existingIds.has(row.id)) { skipped++; return; }
    appendRecordSql_(SHEET_NAMES.sponsorshipPackages, SPONSORSHIP_PACKAGE_FIELDS, row);
    existingIds.add(row.id);
    migrated++;
  });
  Logger.log('SponsorshipPackages migration: migrated=' + migrated + ' skipped=' + skipped + ' (sheet had ' + sheetRows.length + ' total)');
}

// One-time manual check (confirmed 2026-10-08; run from the Apps Script
// editor's Run button) -- Phase 4 cutover verification for
// SponsorshipPackages, the last entity in the entire migration. Exercises
// its own CRUD, both bulk-update cascades INTO it (from deleteTentpoleShow
// via showId and seasonYearId, and from deleteSeasonYear via seasonYearId),
// and 'placements'/'blendGroups' JSON_FIELDS blobs round-tripping as real
// arrays.
function testSponsorshipPackagesCutover() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }

  const pkgId = Utilities.getUuid();
  const placements = [{ title: 'Test Placement', investment: 500 }];
  const blendGroups = [{ label: 'Test Blend', items: [] }];

  doPost({ parameter: { action: 'createSponsorshipPackage', payload: JSON.stringify({ id: pkgId, name: 'Cutover Test Package', placements: placements, blendGroups: blendGroups }) } });
  let list = JSON.parse(doGet({ parameter: { action: 'listSponsorshipPackages' } }).getContent());
  check('Package appears via doGet(listSponsorshipPackages) after doPost(createSponsorshipPackage)', list.some(function (p) { return p.id === pkgId; }), true);
  check('Package placements round-trips as a real array', list.find(function (p) { return p.id === pkgId; }).placements, placements);
  check('Package blendGroups round-trips as a real array', list.find(function (p) { return p.id === pkgId; }).blendGroups, blendGroups);

  doPost({ parameter: { action: 'updateSponsorshipPackage', payload: JSON.stringify({ id: pkgId, name: 'Cutover Test Package Renamed' }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listSponsorshipPackages' } }).getContent());
  check('Package renamed via doPost(updateSponsorshipPackage)', list.find(function (p) { return p.id === pkgId; }).name, 'Cutover Test Package Renamed');

  // deleteSeasonYear's cascade -- field cleared to ''.
  const seasonYearId = Utilities.getUuid();
  doPost({ parameter: { action: 'createSeasonYear', payload: JSON.stringify({ id: seasonYearId, showId: '', name: 'Cutover Test Season' }) } });
  updateRecordSql_(SHEET_NAMES.sponsorshipPackages, SPONSORSHIP_PACKAGE_FIELDS, 'id', pkgId, { id: pkgId, seasonYearId: seasonYearId });
  doPost({ parameter: { action: 'deleteSeasonYear', payload: JSON.stringify({ id: seasonYearId }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listSponsorshipPackages' } }).getContent());
  check('Package seasonYearId cleared via doPost(deleteSeasonYear)', list.find(function (p) { return p.id === pkgId; }).seasonYearId, '');

  // deleteTentpoleShow's cascade -- both its own showId field AND (via a
  // child SeasonYear) the seasonYearId field get cleared in one call.
  const showId = Utilities.getUuid();
  const childSeasonYearId = Utilities.getUuid();
  doPost({ parameter: { action: 'createTentpoleShow', payload: JSON.stringify({ id: showId, name: 'Cutover Test Show ' + showId }) } });
  doPost({ parameter: { action: 'createSeasonYear', payload: JSON.stringify({ id: childSeasonYearId, showId: showId, name: 'Child Season' }) } });
  updateRecordSql_(SHEET_NAMES.sponsorshipPackages, SPONSORSHIP_PACKAGE_FIELDS, 'id', pkgId, { id: pkgId, showId: showId, seasonYearId: childSeasonYearId });
  doPost({ parameter: { action: 'deleteTentpoleShow', payload: JSON.stringify({ id: showId }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listSponsorshipPackages' } }).getContent());
  const pkgAfterShowDelete = list.find(function (p) { return p.id === pkgId; });
  check('Package showId cleared via doPost(deleteTentpoleShow)', pkgAfterShowDelete.showId, '');
  check('Package seasonYearId cleared via doPost(deleteTentpoleShow) (child SeasonYear bulk-delete)', pkgAfterShowDelete.seasonYearId, '');

  doPost({ parameter: { action: 'deleteSponsorshipPackage', payload: JSON.stringify({ id: pkgId }) } });
  list = JSON.parse(doGet({ parameter: { action: 'listSponsorshipPackages' } }).getContent());
  check('Package gone via doGet(listSponsorshipPackages) after doPost(deleteSponsorshipPackage)', list.some(function (p) { return p.id === pkgId; }), false);

  Logger.log(results.join('\n'));
  return results;
}

// Diagnostic (2026-10-08) -- investigates post-cutover timeout reports by
// timing every entity's readRowsSql_ call individually, plus
// getServiceAccountAccessToken_ cold vs. warm (to confirm the CacheService
// token cache from the Users cutover is actually being hit).
function diagnoseSqlReadLatency() {
  CacheService.getScriptCache().remove('sql_connect_access_token');
  const t0 = Date.now();
  getServiceAccountAccessToken_();
  const coldTokenMs = Date.now() - t0;
  const t1 = Date.now();
  getServiceAccountAccessToken_();
  const warmTokenMs = Date.now() - t1;
  Logger.log('Access token: cold=' + coldTokenMs + 'ms warm(cached)=' + warmTokenMs + 'ms');

  const entities = [
    SHEET_NAMES.tags, SHEET_NAMES.holdCos, SHEET_NAMES.pitchTeams, SHEET_NAMES.tentpoleShows,
    SHEET_NAMES.agencyHoldCo, SHEET_NAMES.teamRoster, SHEET_NAMES.seasonYears,
    SHEET_NAMES.placementCategories, SHEET_NAMES.placementMenuItems, SHEET_NAMES.users,
    SHEET_NAMES.projectFileLinks, SHEET_NAMES.closedDeals, SHEET_NAMES.projects,
    SHEET_NAMES.versions, SHEET_NAMES.sponsorshipPackages,
  ];
  entities.forEach(function (sheetName) {
    const start = Date.now();
    let rows;
    try {
      rows = readRowsSql_(sheetName);
    } catch (e) {
      Logger.log(sheetName + ': ERROR -- ' + e.message);
      return;
    }
    Logger.log(sheetName + ': ' + rows.length + ' rows in ' + (Date.now() - start) + 'ms');
  });
}

// =====================================================================
// Full regression suite (added 2026-10-12) -- runs every *Cutover()/
// testSqlStorageLayer test in one pass instead of the 15 separate
// functions needing to be found and run individually. This is the
// closest thing this backend has to an automated test suite: Apps
// Script has no native CI runner, and the domain-restricted web app
// auth model (see media-planner-app/src/api/appsScript.js's own
// comments) means there's no simple bearer-token way for an external
// CI system to call in as an authenticated user either -- so for now
// this stays a manually-run, one-click regression check rather than a
// true CI gate.
//
// STANDING PRACTICE: run this from the Apps Script editor (select
// runAllTests, click Run) after ANY change to Code.gs, before pushing
// live -- not just for the specific entity you touched. Every one of
// these tests creates its own randomly-named rows and cleans them up
// afterward, so it's safe to run repeatedly against the live Postgres
// data without side effects, with one exception: testProjectsCutover's
// real end-to-end createProject check leaves behind one real (harmless)
// Drive folder each run -- see that function's own header comment.
// One-time manual recovery (confirmed 2026-10-29; run from the Apps Script
// editor's Run button, not exposed via doGet/doPost). Writes one version
// back to the database from the project's INTERNAL_*.json Drive copy,
// which every successful planner sync rewrites in full. Used when a
// planner's work reached that file but the database copy was later
// overwritten by someone else's stale browser copy (before the planner's
// multi-user sync fix). Only the named version's name/packages/total are
// touched. updatedBy is deliberately not the person running this, so every
// planner treats it as someone else's change (pulled in, or asked about)
// rather than as their own save to overwrite.
function restoreVersionFromDriveCopy_(projectId, versionId) {
  const project = readRowsSql_(SHEET_NAMES.projects).find(function (p) { return p.id === projectId; });
  if (!project) throw new Error('No project ' + projectId);
  if (!project.folderId) throw new Error('Project has no Drive folder: ' + projectId);
  const filename = internalProjectFileName_(project);
  const files = DriveApp.getFolderById(project.folderId).getFilesByName(filename);
  if (!files.hasNext()) throw new Error('No ' + filename + ' in the project folder');
  const file = files.next();
  const copy = JSON.parse(file.getBlob().getDataAsString());
  const fromFile = (copy.versions || []).find(function (v) { return v.id === versionId; });
  if (!fromFile) throw new Error('Version ' + versionId + ' is not in ' + filename);
  const current = readRowsSql_(SHEET_NAMES.versions).find(function (v) { return v.id === versionId; });
  if (!current) throw new Error('Version ' + versionId + ' is not in the database');

  const packages = fromFile.packages || [];
  const total = packages.reduce(function (sum, p) { return sum + (Number(p.totalInvestment) || 0); }, 0);
  Logger.log('Drive copy: ' + filename + ', last saved ' + file.getLastUpdated());
  Logger.log('Before: "' + current.name + '" -- ' + (current.packages || []).length + ' package(s), total ' + current.totalInvestment);

  updateRecordSql_(SHEET_NAMES.versions, VERSION_FIELDS, 'id', versionId, {
    id: versionId,
    name: fromFile.name,
    packages: packages,
    totalInvestment: total,
    updatedAt: new Date().toISOString(),
    updatedBy: 'Drive copy restore (run by ' + Session.getActiveUser().getEmail() + ')',
  });

  const after = readRowsSql_(SHEET_NAMES.versions).find(function (v) { return v.id === versionId; });
  Logger.log('After:  "' + after.name + '" -- ' + (after.packages || []).length + ' package(s), total ' + after.totalInvestment);
}

// MTV Unplugged x CLEAR & VISA -- "VISA $15MM PLAN" (2026-10-29).
function restoreVisaPlanFromDriveCopy() {
  restoreVersionFromDriveCopy_('proj-1793125340043', '613c162c-06fc-4e5c-a120-21d6acc6ce5a');
}

function testRecentErrors() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }
  const versionId = 'recent-errors-test-' + Utilities.getUuid();
  let threw = false;
  try {
    doPost({ parameter: { action: 'updateVersion', payload: JSON.stringify({ id: versionId, completedDate: 'not-a-date' }) } });
  } catch (e) {
    threw = true;
  }
  check('A failing doPost still throws', threw, true);
  const latest = JSON.parse(doGet({ parameter: { action: 'recentErrors' } }).getContent())[0] || {};
  check('Failure recorded with its action and id', [latest.action, latest.id], ['updateVersion', versionId]);
  check('Failure recorded with the error text', !!latest.error, true);
  return results;
}

function testUserEmailMatching() {
  const results = [];
  function check(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push((pass ? 'PASS' : 'FAIL') + ' -- ' + label + (pass ? '' : (': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))));
  }
  check('Emails match regardless of case and surrounding spaces', sameEmail_(' Brennen.Clark@Paramount.com ', 'brennen.clark@paramount.com'), true);
  check('Different emails still do not match', sameEmail_('a@paramount.com', 'b@paramount.com'), false);

  // The real signed-in user, stored with different capitalization, still gets write.
  const me = Session.getActiveUser().getEmail();
  const shouted = me.toUpperCase();
  doPost({ parameter: { action: 'createUser', payload: JSON.stringify({ email: shouted, name: 'Case Test' }) } });
  const users = readRowsSql_(SHEET_NAMES.users);
  const matched = getCurrentUser_();
  check('Signed-in user still resolves to write with an extra differently-cased row', matched.role, 'write');
  if (users.some(function (u) { return u.email === shouted; }) && shouted !== me) {
    deleteRowByKeySql_(SHEET_NAMES.users, USER_FIELDS, 'email', shouted);
  }
  return results;
}

function runAllTests() {
  const suites = [
    ['SqlStorageLayer', testSqlStorageLayer],
    ['TagsCutover', testTagsCutover],
    ['HoldCosCutover', testHoldCosCutover],
    ['PitchTeamsCutover', testPitchTeamsCutover],
    ['TentpoleShowsCutover', testTentpoleShowsCutover],
    ['AgencyHoldCoCutover', testAgencyHoldCoCutover],
    ['TeamRosterCutover', testTeamRosterCutover],
    ['SeasonYearsCutover', testSeasonYearsCutover],
    ['PlacementCategoriesAndMenuItemsCutover', testPlacementCategoriesAndMenuItemsCutover],
    ['UsersCutover', testUsersCutover],
    ['ProjectFileLinksCutover', testProjectFileLinksCutover],
    ['ClosedDealsCutover', testClosedDealsCutover],
    ['ProjectsCutover', testProjectsCutover],
    ['VersionsCutover', testVersionsCutover],
    ['SponsorshipPackagesCutover', testSponsorshipPackagesCutover],
    ['RecentErrors', testRecentErrors],
    ['UserEmailMatching', testUserEmailMatching],
  ];

  let totalPass = 0, totalFail = 0;
  const failureDetails = [];
  const summaryLines = [];

  suites.forEach(function (entry) {
    const name = entry[0];
    const fn = entry[1];
    let rows;
    try {
      rows = fn();
    } catch (e) {
      totalFail++;
      summaryLines.push('ERROR -- ' + name + ' threw: ' + e.message);
      failureDetails.push(name + ': threw ' + e.message);
      return;
    }
    let suitePass = 0, suiteFail = 0;
    rows.forEach(function (line) {
      if (line.indexOf('PASS') === 0) { suitePass++; totalPass++; }
      else { suiteFail++; totalFail++; failureDetails.push(name + ': ' + line); }
    });
    summaryLines.push((suiteFail === 0 ? 'OK  ' : 'FAIL') + ' -- ' + name + ' (' + suitePass + ' pass, ' + suiteFail + ' fail)');
  });

  Logger.log('===== runAllTests summary =====');
  Logger.log(summaryLines.join('\n'));
  Logger.log('===== Totals: ' + totalPass + ' passed, ' + totalFail + ' failed =====');
  if (failureDetails.length) {
    Logger.log('===== Failure detail =====');
    Logger.log(failureDetails.join('\n'));
  }
}
