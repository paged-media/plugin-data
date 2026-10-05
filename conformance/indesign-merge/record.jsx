// Ask InDesign how Data Merge lays records out (docs/design/oracles.md).
// Driven by record.sh, which defines the globals:
//   PAGED_DM_DIR    conformance/indesign-merge (fixtures.json, csv/, images/)
//   PAGED_DM_STAGE  a scratch dir InDesign can read and write
//   PAGED_DM_ONLY   optional fixture id (record one at a time)
//
// Per fixture: build the template document from fixtures.json, turn every
// <<field>> into a real Data Merge text placeholder and every image frame into
// an image placeholder, save the template as templates/<id>.idml, merge every
// record into a new document, and write recorded/<id>.json with the merged
// document's facts: pages, and on each page every text frame (bounds, the
// frame's own text, line count, overset) and every rectangle (bounds, placed
// image name and bounds). Nothing is saved but the template IDML and the JSON.

(function () {
    var DIR = String($.global.PAGED_DM_DIR);
    var STAGE = String($.global.PAGED_DM_STAGE);
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
    function bounds(a) {
        return [a[0], a[1], a[2], a[3]];
    }
    function closeAll() {
        while (app.documents.length) app.documents[0].close(SaveOptions.NO);
    }

    var spec = eval("(" + readText(DIR + "/fixtures.json") + ")");

    // Stage the CSV. An @field column holds a file name relative to images/;
    // Data Merge wants a full path, so the staged copy carries one.
    function stageCsv(fx) {
        var csv = readText(DIR + "/csv/" + fx.id + ".csv");
        var lines = csv.split(/\r\n|\n/);
        var header = lines[0].split(",");
        var imageCol = -1;
        for (var i = 0; i < header.length; i++) if (header[i].charAt(0) === "@") imageCol = i;
        if (imageCol >= 0) {
            for (var r = 1; r < lines.length; r++) {
                if (!lines[r]) continue;
                var cells = lines[r].split(",");
                File(DIR + "/images/" + cells[imageCol]).copy(STAGE + "/" + cells[imageCol]);
                cells[imageCol] = STAGE + "/" + cells[imageCol];
                lines[r] = cells.join(",");
            }
        }
        var path = STAGE + "/" + fx.id + ".csv";
        writeText(path, lines.join("\r\n"));
        return File(path);
    }

    function buildTemplate(fx) {
        var doc = app.documents.add(false);
        var dp = doc.documentPreferences;
        dp.facingPages = false;
        dp.pagesPerDocument = 1;
        dp.pageWidth = spec.page.width;
        dp.pageHeight = spec.page.height;
        var m = doc.pages[0].marginPreferences;
        m.top = spec.page.margins.top;
        m.left = spec.page.margins.left;
        m.bottom = spec.page.margins.bottom;
        m.right = spec.page.margins.right;
        var mm = doc.masterSpreads[0].pages;
        for (var p = 0; p < mm.length; p++) {
            mm[p].marginPreferences.top = spec.page.margins.top;
            mm[p].marginPreferences.left = spec.page.margins.left;
            mm[p].marginPreferences.bottom = spec.page.margins.bottom;
            mm[p].marginPreferences.right = spec.page.margins.right;
        }
        var page = doc.pages[0];
        var items = [];
        for (var i = 0; i < fx.frames.length; i++) {
            var fr = fx.frames[i];
            if (fr.kind === "text") {
                var tf = page.textFrames.add({ geometricBounds: fr.bounds });
                tf.textFramePreferences.insetSpacing = [0, 0, 0, 0];
                tf.contents = fr.lines.join("\r");
                var t = tf.parentStory.texts[0];
                try { t.appliedFont = app.fonts.itemByName(spec.text.font); } catch (e1) {}
                t.pointSize = spec.text.size;
                t.leading = spec.text.leading;
                t.spaceBefore = 0;
                t.spaceAfter = 0;
                items.push({ fr: fr, item: tf });
            } else {
                var rect = page.rectangles.add({ geometricBounds: fr.bounds });
                rect.strokeWeight = 0;
                items.push({ fr: fr, item: rect });
            }
        }
        return { doc: doc, items: items };
    }

    function placePlaceholders(doc, items) {
        var fields = doc.dataMergeProperties.dataMergeFields;
        function field(name) {
            for (var i = 0; i < fields.length; i++) if (fields[i].fieldName === name || "@" + fields[i].fieldName === name) return fields[i];
            throw new Error("no data merge field " + name);
        }
        for (var i = 0; i < items.length; i++) {
            var fr = items[i].fr, item = items[i].item;
            if (fr.kind === "image") {
                doc.dataMergeImagePlaceholders.add(item, field(fr.field));
                continue;
            }
            // Replace <<name>> markers back to front so earlier offsets hold.
            var story = item.parentStory;
            var text = String(story.contents);
            var re = /<<([^>]+)>>/g, hits = [], mt;
            while ((mt = re.exec(text)) !== null) hits.push({ at: mt.index, len: mt[0].length, name: mt[1] });
            for (var h = hits.length - 1; h >= 0; h--) {
                story.characters.itemByRange(hits[h].at, hits[h].at + hits[h].len - 1).remove();
                doc.dataMergeTextPlaceholders.add(story, story.insertionPoints[hits[h].at], field(hits[h].name));
            }
        }
    }

    function setOptions(doc, merge) {
        var pref = doc.dataMergeProperties.dataMergePreferences;
        pref.recordSelection = RecordSelection.ALL_RECORDS;
        // The merged layout's margins (Multiple Record Layout): the page's own.
        pref.topMargin = spec.page.margins.top;
        pref.leftMargin = spec.page.margins.left;
        pref.bottomMargin = spec.page.margins.bottom;
        pref.rightMargin = spec.page.margins.right;
        if (merge.recordsPerPage === "multiple") {
            pref.recordsPerPage = RecordsPerPage.MULTIPLE_RECORD;
            pref.arrangeBy = merge.arrangeBy === "columns" ? ArrangeBy.COLUMNS_FIRST : ArrangeBy.ROWS_FIRST;
            pref.rowSpacing = merge.rowSpacing || 0;
            pref.columnSpacing = merge.columnSpacing || 0;
        } else {
            pref.recordsPerPage = RecordsPerPage.SINGLE_RECORD;
        }
        var opt = doc.dataMergeOptions;
        opt.removeBlankLines = merge.removeBlankLines === true;
        opt.linkImages = true;
        opt.centerImage = merge.centerImage === true;
        if (merge.fitting === "proportional") opt.fittingOption = Fitting.PROPORTIONAL;
        try { opt.createNewDocument = true; } catch (e2) {}
    }

    function facts(doc) {
        var pages = [];
        for (var p = 0; p < doc.pages.length; p++) {
            var page = doc.pages[p];
            var texts = [], images = [];
            for (var f = 0; f < page.textFrames.length; f++) {
                var tf = page.textFrames[f];
                texts.push({
                    bounds: bounds(tf.geometricBounds),
                    text: tf.texts.length ? String(tf.texts[0].contents) : "",
                    lines: tf.lines.length,
                    overset: tf.overflows,
                    story_length: tf.parentStory.characters.length
                });
            }
            for (var r = 0; r < page.rectangles.length; r++) {
                var rect = page.rectangles[r], g = null;
                if (rect.allGraphics.length) {
                    var gr = rect.allGraphics[0];
                    g = {
                        name: gr.itemLink && gr.itemLink.isValid ? String(gr.itemLink.name) : null,
                        bounds: bounds(gr.geometricBounds)
                    };
                }
                images.push({ bounds: bounds(rect.geometricBounds), graphic: g });
            }
            pages.push({ name: String(page.name), bounds: bounds(page.bounds), text_frames: texts, rectangles: images });
        }
        return pages;
    }

    function record(fx) {
        closeAll();
        var t = buildTemplate(fx);
        var doc = t.doc;
        doc.dataMergeProperties.selectDataSource(stageCsv(fx));
        placePlaceholders(doc, t.items);
        setOptions(doc, fx.merge);
        // The template InDesign itself wrote (Wave 5 opens it in our engine).
        doc.save(File(STAGE + "/" + fx.id + ".indd"));
        doc.exportFile(ExportFormat.INDESIGN_MARKUP, File(DIR + "/templates/" + fx.id + ".idml"));
        var before = app.documents.length;
        doc.dataMergeProperties.mergeRecords();
        var merged = null;
        for (var i = 0; i < app.documents.length; i++) if (app.documents[i] !== doc && app.documents[i].id !== doc.id) merged = app.documents[i];
        if (!merged || app.documents.length === before) throw new Error("mergeRecords produced no new document");
        var out = {
            fixture: fx.id,
            indesign_version: String(app.version),
            template: { pages: facts(doc) },
            merged: { page_count: merged.pages.length, pages: facts(merged) }
        };
        writeText(DIR + "/recorded/" + fx.id + ".json", toJSON(out) + "\n");
        closeAll();
    }

    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS;
    var log = [];
    for (var i = 0; i < spec.fixtures.length; i++) {
        var fx = spec.fixtures[i];
        if (ONLY && fx.id !== ONLY) continue;
        try {
            record(fx);
            log.push(fx.id + ": ok");
        } catch (e) {
            log.push(fx.id + ": ERROR " + e.message + " (line " + e.line + ")");
            try { closeAll(); } catch (e3) {}
        }
    }
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.INTERACT_WITH_ALL;
    writeText(STAGE + "/record.log", log.join("\n") + "\n");
})();
