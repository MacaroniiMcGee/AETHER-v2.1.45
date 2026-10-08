// OSDP frame decoder: the ONE place that turns bytes into plain English.
// Everything that shows OSDP traffic (live trace, saved captures, exports,
// the analyzer) goes through parse() + describe(), so fixing a wording or a
// field here fixes it everywhere.
//
// Field layouts, code tables and wording come from SIA OSDP v2.2.2
// (osdp-spec-2.2.2.json, extracted from the spec PDF). Page numbers in
// comments are the printed page numbers of that document.
'use strict';

const SPEC = require('./os