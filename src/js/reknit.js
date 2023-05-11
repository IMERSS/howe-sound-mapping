/* eslint-env node */

"use strict";

const fs = require("fs-extra"),
    linkedom = require("linkedom"),
    fluid = require("infusion");

const maxwell = fluid.registerNamespace("maxwell");

require("./utils.js");

/** Parse an HTML document supplied as a symbolic reference into a linkedom DOM document
 * @param {String} path - A possibly module-qualified path reference, e.g. "%maxwell/src/html/template.html"
 * @return {Document} The document parsed into a DOM representation
 */
maxwell.parseDocument = function (path) {
    const resolved = fluid.module.resolvePath(path);
    const text = fs.readFileSync(resolved, "utf8");
    return linkedom.parseHTML(text).document;
};

maxwell.writeFile = function (filename, data) {
    fs.writeFileSync(filename, data, "utf8");
    const stats = fs.statSync(filename);
    console.log("Written " + stats.size + " bytes to " + filename);
};

// Hide the divs which host the original leaflet maps and return their respective section headers
maxwell.hideLeafletWidgets = function (container) {
    const widgets = [...container.querySelectorAll(".html-widget.leaflet")];
    widgets.forEach(function (widget) {
        widget.removeAttribute("style");
    });
    const sections = widgets.map(widget => widget.closest(".section.level2"));
    console.log("Found " + sections.length + " sections holding Leaflet widgets");
    return sections;
};

/** Compute figures to move to data pane, by searching for selector `.data-pane`, and if any parent is found
 * with class `figure`, widening the scope to that
 * @param {Element} container - The DOM container to be searched for elements to move
 * @return {Element[]} - An array of DOM elements to be moved to the data pane
 */
maxwell.figuresToMove = function (container) {
    const toMoves = [...container.querySelectorAll(".data-pane")];
    const widened = toMoves.map(function (toMove) {
        const figure = toMove.closest(".figure");
        return figure || toMove;
    });
    return widened;
};

/** Move plotly widgets which have siblings which are maps into children of the .mxcw-data pane
 * @param {Document} template - The document for the template structure into which markup is being integrated
 * @param {Element[]} sections - The array of section elements found holding leaflet maps
 * @param {Element} container - The container node with class `.main-container` found in the original knitted markup
 * @return {Element[]} An array of data panes corresponding to the input section nodes
 */
maxwell.movePlotlyWidgets = function (template, sections, container) {
    const data = template.querySelector(".mxcw-data");
    if (!data) {
        throw "Error in template structure - data pane not found with class mxcw-data";
    }
    const dataDivs = sections.map(() => {
        const div = template.createElement("div");
        div.setAttribute("class", "mxcw-widgetPane");
        data.appendChild(div);
        return div;
    });

    const plotlys = [...container.querySelectorAll(".html-widget.plotly")];
    console.log("Found " + plotlys.length + " Plotly widgets in " + sections.length + " heading sections");
    const toDatas = maxwell.figuresToMove(container);
    console.log("Found " + toDatas.length + " elements to move to data pane");
    const toMoves = [...plotlys, ...toDatas];
    toMoves.forEach(function (toMove, i) {
        const closest = toMove.closest(".section.level2");
        const index = sections.indexOf(closest);
        console.log("Found section for plotly widget at index " + index);
        if (index !== -1) {
            toMove.setAttribute("data-section-index", "" + index);
            dataDivs[index].prepend(toMove);
        } else {
            console.log("Ignoring widget at index " + i + " since it has no sibling map");
        }
    });
    return dataDivs;
};

maxwell.transferNodeContent = function (container, template, selector) {
    const containerNode = container.querySelector(selector);
    const templateNode = template.querySelector(selector);
    templateNode.innerHTML = containerNode.innerHTML;
    containerNode.remove();
};

maxwell.integratePaneHandler = function (paneHandler, key) {
    const plotDataFile = "%maxwell/viz_data/" + key + "-plotData.json";
    let plotData;
    const resolved = fluid.module.resolvePath(plotDataFile);
    if (fs.existsSync(resolved)) {
        plotData = maxwell.loadJSON5File(resolved);
    } else {
        console.log("plotData file for pane " + key + " not found");
    }
    const toMerge = fluid.censorKeys(plotData, ["palette", "taxa"]);
    return {...paneHandler, ...toMerge};
};

maxwell.reknitFile = async function (infile, outfile, options) {
    const document = maxwell.parseDocument(fluid.module.resolvePath(infile));
    const container = document.querySelector(".main-container");
    const sections = maxwell.hideLeafletWidgets(container);
    const template = maxwell.parseDocument(fluid.module.resolvePath(options.template));
    maxwell.movePlotlyWidgets(template, sections, container);

    maxwell.transferNodeContent(document, template, "h1");
    maxwell.transferNodeContent(document, template, "title");

    await maxwell.asyncForEach(options.transforms || [], async (rec) => {
        const file = require(fluid.module.resolvePath(rec.file));
        const transform = file[rec.func];
        await transform(document, container);
    });
    const target = template.querySelector(".mxcw-content");
    target.appendChild(container);
    const paneHandlers = options.paneHandlers;
    if (paneHandlers) {
        const integratedHandlers = fluid.transform(paneHandlers, function (paneHandler, key) {
            return maxwell.integratePaneHandler(paneHandler, key);
        });
        const paneMapText = "maxwell.scrollyPaneHandlers = " + JSON.stringify(integratedHandlers) + ";\n";
        const scriptNode = template.createElement("script");
        scriptNode.innerHTML = paneMapText;
        const head = template.querySelector("head");
        head.appendChild(scriptNode);
    }
    const outMarkup = "<!DOCTYPE html>" + template.documentElement.outerHTML;
    maxwell.writeFile(fluid.module.resolvePath(outfile), outMarkup);
};

/** Copy dependencies into docs directory for GitHub pages **/

const copyDep = function (source, target, replaceSource, replaceTarget) {
    const targetPath = fluid.module.resolvePath(target);
    const sourceModule = fluid.module.refToModuleName(source);
    if (sourceModule && sourceModule !== "maxwell") {
        require(sourceModule);
    }
    const sourcePath = fluid.module.resolvePath(source);
    if (replaceSource) {
        const text = fs.readFileSync(sourcePath, "utf8");
        const replaced = text.replace(replaceSource, replaceTarget);
        fs.writeFileSync(targetPath, replaced, "utf8");
    } else {
        fs.copySync(sourcePath, targetPath);
    }
};

const reknit = async function () {
    const config = maxwell.loadJSON5File("%maxwell/config.json5");
    await maxwell.asyncForEach(config.reknitJobs, async (rec) => maxwell.reknitFile(rec.infile, rec.outfile, rec.options));

    config.copyJobs.forEach(function (dep) {
        copyDep(dep.source, dep.target, dep.replaceSource, dep.replaceTarget);
    });
};

reknit().then();


