// ADR 559's InDesign lane (driven by record.sh): open every fixtures/*.idml
// paged wrote, record what InDesign sees, save it again.
//   recorded/<id>.json   — open ok?, every x-paged:media.paged.data label on a
//                          page item (extractLabel), Data Merge fields and
//                          placeholders, and for dm-* the merged records
//   recorded/<id>.rt.idml — InDesign's re-save (File ▸ Export ▸ IDML)
// Globals from record.sh: PAGED_IB_DIR, PAGED_IB_STAGE, PAGED_IB_ONLY.

(function () {
    var DIR = String($.global.PAGED_IB_DIR);
    var STAGE = String($.global.PAGED_IB_STAGE);
    var ONLY = String($.global.PAGED_IB_ONLY || "");
    var KEY = "x-paged:media.paged.data";
    var LOG = [];
    function log(s) { LOG.push(s); }
    var ONLY = String($.global.PAGED_DM_ONLY || "");

    // ── tiny ES3 JSON writer (ExtendScript has no JSON object) ──────────────
    function str(s) {
        s = String(s);
        var out = '"';
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i), code = s.charCodeAt(i);
            if (c === '"') out += '\\"';
            else if (c === "\\") out += "\\\\";
            else if (c === "\n") out += "\\n";
            else if (c === "\r") out += "\\r";
            else if (c === "\t") out += "\\t";
            else if (code < 32 || code === 0x2028 || code === 0x2029) {
                var h = code.toString(16);
                while (h.length < 4) h = "0" + h;
                out += "\\u" + h;
            } else out += c;
        }
        return out + '"';
    }
    function toJSON(v, ind) {
        ind = ind || "";
        if (v === null || v === undefined) return "null";
        if (typeof v === "number") return isFinite(v) ? String(Math.round(v * 1000) / 1000) : "null";
        if (typeof v === "boolean") return v ? "true" : "false";
        if (typeof v === "string") return str(v);
        var next = ind + "  ", parts = [], k;
        if (v instanceof Array) {
            var flat = true;
            for (k = 0; k < v.length; k++) if (typeof v[k] !== "number") flat = false;
            if (flat) {
                for (k = 0; k < v.length; k++) parts.push(toJSON(v[k]));
                return "[" + parts.join(", ") + "]";
            }
            for (k = 0; k < v.length; k++) parts.push(next + toJSON(v[k], next));
            return parts.length ? "[\n" + parts.join(",\n") + "\n" + ind + "]" : "[]";
        }
        for (k in v) if (v.hasOwnProperty(k)) parts.push(next + str(k) + ": " + toJSON(v[k], next));
        return parts.length ? "{\n" + parts.join(",\n") + "\n" + ind + "}" : "{}";
    }
    function readText(path) {
        var f = File(path);
        f.encoding = "UTF-8";
        f.open("r");
        var s = f.read();
        f.close();
        return s;
    }
    function writeText(path, s) {
        var f = File(path);
        f.encoding = "UTF-8";
        f.lineFeed = "Unix";
        f.open("w");
        f.write(s);
        f.close();
    }

    function close(doc) { try { if (doc && doc.isValid) doc.close(SaveOptions.NO); } catch (e) {} }

    function labels(doc) {
        var out = [], items = doc.allPageItems;
        for (var i = 0; i < items.length; i++) {
            var it = items[i], v = "";
            try { v = String(it.extractLabel(KEY)); } catch (e) { v = ""; }
            if (v) out.push({ item: String(it.constructor.name), name: KEY, value: v });
        }
        return out;
    }

    function dataMerge(doc) {
        var dmp = doc.dataMergeProperties, out = { fields: [], text_placeholders: [], image_placeholders: [] };
        for (var a = 0; a < dmp.dataMergeFields.length; a++) out.fields.push(String(dmp.dataMergeFields[a].fieldName));
        for (var b = 0; b < doc.dataMergeTextPlaceholders.length; b++) out.text_placeholders.push(String(doc.dataMergeTextPlaceholders[b].field.fieldName));
        for (var c = 0; c < doc.dataMergeImagePlaceholders.length; c++) out.image_placeholders.push(String(doc.dataMergeImagePlaceholders[c].field.fieldName));
        return out;
    }

    function merge(doc) {
        var before = {};
        for (var i = 0; i < app.documents.length; i++) before[app.documents[i].id] = true;
        try { doc.dataMergeProperties.mergeRecords(); } catch (e) { return "mergeRecords FAILED: " + e; }
        var merged = null;
        for (var j = 0; j < app.documents.length; j++) if (!before[app.documents[j].id]) merged = app.documents[j];
        if (!merged) return "mergeRecords produced no document";
        var pages = [];
        for (var p = 0; p < merged.pages.length; p++) {
            var pg = merged.pages[p], texts = [];
            for (var t = 0; t < pg.textFrames.length; t++) texts.push(String(pg.textFrames[t].parentStory.contents));
            pages.push({ texts: texts });
        }
        close(merged);
        return { page_count: pages.length, pages: pages };
    }

    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    try {
        var files = Folder(STAGE).getFiles(function (f) { return f instanceof File && /\.idml$/.test(f.name); });
        for (var n = 0; n < files.length; n++) {
            var file = files[n], id = file.name.replace(/\.idml$/, "");
            if (ONLY && ("," + ONLY + ",").indexOf("," + id + ",") < 0) continue;
            var out = { fixture: file.name, indesign_version: String(app.version) }, doc = null;
            try {
                doc = app.open(file, false);
                out.open = "ok";
                out.labels = labels(doc);
                out.data_merge = dataMerge(doc);
                doc.exportFile(ExportFormat.INDESIGN_MARKUP, File(DIR + "/recorded/" + id + ".rt.idml"));
                if (/^dm-/.test(id)) out.merge = merge(doc);
                close(doc);
                log(id + ": ok");
            } catch (e) {
                out.error = String(e) + " line " + e.line;
                log(id + ": ERROR " + e + " line " + e.line);
                close(doc);
            }
            writeText(DIR + "/recorded/" + id + ".json", toJSON(out) + "\n");
        }
    } finally {
        app.scriptPreferences.userInteractionLevel = UserInteractionLevels.INTERACT_WITH_ALL;
        writeText(STAGE + "/record.log", LOG.join("\n") + "\n");
    }
})();
