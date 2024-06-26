import path from "path";
import { cwd } from "process";
import { spawnSync, spawn } from "child_process";
import { readFileSync, existsSync, promises as fsp } from "fs";
import getEtag from "etag";
import colors from "picocolors";
import strip from "strip-ansi";

/*
 ** Code from Vite
 */

// TODO: move in separate file

const ERR_OPTIMIZE_DEPS_PROCESSING_ERROR = "ERR_OPTIMIZE_DEPS_PROCESSING_ERROR";
const ERR_OUTDATED_OPTIMIZED_DEP = "ERR_OUTDATED_OPTIMIZED_DEP";
const NULL_BYTE_PLACEHOLDER = `__x00__`;
const VALID_ID_PREFIX = `/@id/`;

const queryRE = /\?.*$/s;
const hashRE = /#.*$/s;
const importQueryRE = /(\?|&)import=?(?:&|$)/;
const trailingSeparatorRE = /[\?&]$/;
const timestampRE = /\bt=\d{13}&?\b/;

function removeTimestampQuery(url) {
  return url.replace(timestampRE, "").replace(trailingSeparatorRE, "");
}

function removeImportQuery(url) {
  return url.replace(importQueryRE, "$1").replace(trailingSeparatorRE, "");
}

// Strip valid id prefix. This is prepended to resolved Ids that are
// not valid browser import specifiers by the importAnalysis plugin.
function unwrapId(id) {
  return id.startsWith(VALID_ID_PREFIX) ? id.slice(VALID_ID_PREFIX.length) : id;
}

const isDebug = !!process.env.DEBUG;

export function genSourceMapUrl(map) {
  if (typeof map !== "string") {
    map = JSON.stringify(map);
  }
  return `data:application/json;base64,${Buffer.from(map).toString("base64")}`;
}

export function getCodeWithSourcemap(type, code, map) {
  if (isDebug) {
    code += `\n/*${JSON.stringify(map, null, 2).replace(/\*\//g, "*\\/")}*/\n`;
  }

  if (type === "js") {
    code += `\n//# sourceMappingURL=${genSourceMapUrl(map ?? undefined)}`;
  } else if (type === "css") {
    code += `\n/*# sourceMappingURL=${genSourceMapUrl(map ?? undefined)} */`;
  }

  return code;
}

const alias = {
  js: "application/javascript",
  css: "text/css",
  html: "text/html",
  json: "application/json",
};

function send(req, res, content, type, options) {
  const {
    etag = getEtag(content, { weak: true }),
    cacheControl = "no-cache",
    headers,
    map,
  } = options;

  if (res.writableEnded) {
    return;
  }

  if (req.headers["if-none-match"] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  res.setHeader("Content-Type", alias[type] || type);
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("Etag", etag);

  if (headers) {
    for (const name in headers) {
      res.setHeader(name, headers[name]);
    }
  }

  // inject source map reference
  if (map && map.mappings) {
    if (type === "js" || type === "css") {
      content = getCodeWithSourcemap(type, content.toString(), map);
    }
  }

  res.statusCode = 200;
  res.end(content);
  return;
}

const cleanUrl = (url) => url.replace(hashRE, "").replace(queryRE, "");

// used to propagate errors for WS in dev server mode
function prepareError(err) {
  // only copy the information we need and avoid serializing unnecessary
  // properties, since some errors may attach full objects (e.g. PostCSS)
  return {
    message: strip(err.message),
    stack: strip(cleanStack(err.stack || "")),
    id: err.id,
    frame: strip(err.frame || ""),
    plugin: err.plugin,
    pluginCode: err.pluginCode,
    loc: err.loc,
  };
}

function buildErrorMessage(err, args, includeStack = true) {
  // if (err.plugin) args.push(`  Plugin: ${colors.magenta(err.plugin)}`)
  // @TODO we can add line and column numbers
  if (err.id) args.push(`${colors.white("file:")} ${colors.cyan(err.id)}`);
  if (err.frame) args.push(colors.yellow(err.frame));
  if (includeStack && err.stack) args.push(cleanStack(err.stack));
  return args.join("\n") + "\n";
}

function cleanStack(stack) {
  return stack
    .split(/\n/g)
    .filter((l) => /^\s*at/.test(l))
    .join("\n");
}

function logWarning(server, err) {
  server.config.logger.warn(
    buildErrorMessage(err, [colors.yellow(err.message)]),
    {
      clear: false,
      timestamp: true,
      error: err,
    }
  );
}

function logError(server, err) {
  server.config.logger.error(
    buildErrorMessage(err, [colors.red(err.message)]),
    {
      clear: false,
      timestamp: true,
      error: err,
    }
  );
}

function logInfo(server, message, clear) {
  server.config.logger.info(message, {
    clear: !!clear,
    timestamp: true,
  });
}

const melangeLogRE =
  /> File "(?<file>.+)", lines? (?<line>[\d-]+)(, characters (?<col>[\d-]+))?:\r?\n(?<frame>(> +(\d+.+|\.\.\.)\r?\n)+)?(> (?<arrows>[ \^]+)\r?\n)?(?<message>> [^]*?)(?=> File|\[\d+\]|\$ .*|$)/g;

function build(buildCommand) {
  let args = buildCommand.split(" ");
  let cmd = args.shift();

  return spawnSync(cmd, args);
}

function buildWatch(watchCommand) {
  let args = watchCommand.split(" ");
  let cmd = args.shift();

  return spawn(cmd, args);
}

function createViteError(match, artifactToSource) {
  let frame = match.groups.frame;
  if (frame) {
    const lineBorderIndex = match.groups.frame.indexOf("|");
    if (match.groups.arrows) {
      frame +=
        match.groups.arrows.slice(0, lineBorderIndex) +
        "| " +
        match.groups.arrows.slice(lineBorderIndex);
    }
  }
  const file = artifactToSource(match.groups.file);

  return {
    plugin: "melange-plugin",
    pluginCode: "MELANGE_COMPILATION_FAILED",
    message: match.groups.message.replace(/^> /gm, "").replace(/^Error: /, ""),
    frame: frame,
    stack: "",
    id: file,
    loc: {
      file: file,
      line: match.groups.line.replace(/-\d+/, ""),
      column: match.groups.col,
    },
    isError: /^> Error: /.test(match.groups.message),
  };
}

function isMelangeSourceType(id) {
  return id.endsWith(".ml") || id.endsWith(".re") || id.endsWith(".res");
}

function tryFiles(files) {
  for (let file of files) {
    if (existsSync(file)) {
      return file;
    }
  }

  return undefined;
}

function parseLog(log, displayedErrors, artifactToSource) {
  const messages = Array.from(log.matchAll(melangeLogRE), (match) => {
    if (displayedErrors.has(match.index)) {
      return undefined;
    } else {
      displayedErrors.add(match.index);
      return createViteError(match, artifactToSource);
    }
  }).filter((err) => err);

  const firstError = messages.find((err) => err.isError);
  const warnings = messages.filter((err) => !err.isError);

  if (firstError) {
    throw [firstError, warnings];
  } else {
    return warnings;
  }
}

export default function melangePlugin(options) {
  const { buildCommand, watchCommand, buildContext, buildTarget, emitDir } =
    options;

  let config;

  const changedSourceFiles = new Set();
  const displayedErrors = new Set();

  const melangeLogFile = () => path.join(config.root, "_build/log");

  const builtPath = (relativeJsPath) => {
    // https://melange.re/v1.0.0/build-system/#javascript-artifacts-layout
    return path.join(
      config.root,
      "_build",
      buildContext || "default",
      emitDir || "",
      buildTarget || "output",
      relativeJsPath || ""
    );
  };

  const artifactPath = (relativeJsPath) => {
    return path.join(
      config.root,
      "_build",
      buildContext || "default",
      relativeJsPath || ""
    );
  };

  const depsDir = () => {
    return builtPath("node_modules");
  };

  const sourceToBuiltFile = (id) => {
    let base;

    if (id.includes(artifactPath(""))) {
      base = artifactPath("");
    } else {
      base = config.root;
    }

    const relativeJsPath = path
      .relative(base, id)
      .replace(/\.(ml|re|res)$/, ".js");

    return builtPath(relativeJsPath);
  };

  const builtFileToSource = (id) => {
    const relativePathAsJs = path.relative(builtPath(), id);

    return tryFiles([
      path.join(config.root, relativePathAsJs.replace(/\.js$/, ".ml")),
      path.join(config.root, relativePathAsJs.replace(/\.js$/, ".re")),
      path.join(config.root, relativePathAsJs.replace(/\.js$/, ".res")),
      path.join(artifactPath(relativePathAsJs).replace(/\.js$/, ".ml")),
      path.join(artifactPath(relativePathAsJs).replace(/\.js$/, ".re")),
      path.join(artifactPath(relativePathAsJs).replace(/\.js$/, ".res")),
    ]);
  };

  const artifactToSource = (id) => {
    if (id.includes(builtPath())) {
      return id.replace(builtPath(), config.root);
    } else {
      return path.join(config.root, id);
    }
  };

  return {
    name: "melange-plugin",
    enforce: "pre",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    buildStart() {
      if (this.meta.watchMode) {
        let child = buildWatch(watchCommand);

        let error = "";

        child.stderr.on("data", (data) => {
          // this.error(data.toString());
          error += data.toString();
        });

        child.on("close", (code) => {
          // console.log(`child process exited with code ${code}`);
          if (code != 0 && error != "") {
            this.error(error);
          }
        });

        process.on("exit", () => {
          child.kill();
        });

        // this does not work at the moment so we rely on handleHotUpdate
        // this.addWatchFile(melangeLogFile());
      } else {
        let child = build(buildCommand);

        if (child.status != 0 && child.stderr) {
          this.error(child.stderr.toString());
        }

        const log = readFileSync(melangeLogFile(), "utf-8");

        try {
          const warnings = parseLog(log, displayedErrors, artifactToSource);

          warnings.forEach((err) => {
            this.warn(buildErrorMessage(err, [colors.yellow(err.message)]));
          });
        } catch (messages) {
          const [error, warnings] = messages;

          warnings.forEach((err) => {
            this.warn(buildErrorMessage(err, [colors.yellow(err.message)]));
          });

          this.error(error);
        }
      }
    },

    async resolveId(source, importer, options) {
      source = cleanUrl(source);
      importer = importer && cleanUrl(importer);
      // console.log(`${source} from ${importer}`);

      // Opam deps can get compiled in
      // `_build/$buildContext/$emitDir/$buildTarget/node_modules/`
      // It's the case for `melange` (stdlib), `melange.belt`,
      // `melange.runtime`, `reason-react`...
      if (
        !source.startsWith("/") &&
        !source.startsWith(".") &&
        existsSync(depsDir() + "/" + source)
      ) {
        return { id: depsDir() + "/" + source, moduleSideEffects: null };
      }

      if (
        !(importer && isMelangeSourceType(importer) && source.startsWith("."))
      ) {
        return null;
      }

      // When a compiled file imports another compiled file,
      // `importer` will be the source file, so we resolve from the compiled file
      // and then return the source path for the resulting file
      importer = sourceToBuiltFile(importer);
      const resolution = path.resolve(path.dirname(importer), source);
      // console.log(`${importer} resolves ${resolution}`);

      if (existsSync(resolution)) {
        // console.log(`${importer} resolves ${resolution} it exists`);
        const sourceFile = builtFileToSource(resolution);
        // console.log(`${source} is ${sourceFile}`);

        if (sourceFile) {
          return { id: sourceFile };
        } else {
          // if the file imported is `runtime_deps` (from dune), there won't be any sourceFile
          return { id: resolution };
        }
      } else {
        const log = await fsp.readFile(melangeLogFile(), "utf-8");

        try {
          const warnings = parseLog(log, displayedErrors, artifactToSource);

          warnings.forEach((err) => {
            this.warn(buildErrorMessage(err, [colors.yellow(err.message)]));
          });
        } catch (messages) {
          const [error, warnings] = messages;

          warnings.forEach((err) => {
            this.warn(buildErrorMessage(err, [colors.yellow(err.message)]));
          });

          this.error(error);
        }
      }

      return null;
    },

    async load(id) {
      id = cleanUrl(id);

      if (isMelangeSourceType(id)) {
        try {
          return await fsp.readFile(sourceToBuiltFile(id), "utf-8");
        } catch (error) {
          const log = await fsp.readFile(melangeLogFile(), "utf-8");

          try {
            const warnings = parseLog(log, displayedErrors, artifactToSource);

            warnings.forEach((err) => {
              this.warn(buildErrorMessage(err, [colors.yellow(err.message)]));
            });
          } catch (messages) {
            const [error, warnings] = messages;

            warnings.forEach((err) => {
              this.warn(buildErrorMessage(err, [colors.yellow(err.message)]));
            });

            this.error(error);
          }

          return null;
        }
      }

      return null;
    },

    async handleHotUpdate({ file, modules, read, server }) {
      // We don't want to send an HMR update for files that have been updated
      // but make the compilation fail. So we store which files have changed,
      // and when the log file shows that a compilation has succeeded, we send
      // an HMR update for those files and reset the list of changed files.

      if (file == melangeLogFile()) {
        const log = await read();

        try {
          const warnings = parseLog(log, displayedErrors, artifactToSource);

          warnings.forEach((err) => {
            logWarning(server, err);
          });

          const changedModules = [...changedSourceFiles]
            .map((file) => [
              ...((server.moduleGraph.getModulesByFile(file) &&
                server.moduleGraph.getModulesByFile(file)) ||
                []),
            ])
            .flat();
          changedSourceFiles.clear();

          return changedModules;
        } catch (messages) {
          const [error, warnings] = messages;

          warnings.forEach((err) => {
            logWarning(server, err);
          });

          logError(server, error);

          server.ws.send({
            type: "error",
            err: prepareError(error),
          });

          return [];
        }
      }

      if (isMelangeSourceType(file)) {
        changedSourceFiles.add(file);
        return [];
      }

      return modules;
    },

    configureServer(server) {
      server.middlewares.use(async function (req, res, next) {
        if (isMelangeSourceType(cleanUrl(req.url))) {
          // this is what the transform middleware does for filetypes it
          // recognizes (js, tx...), this is mostly a copy
          try {
            let url = decodeURI(removeTimestampQuery(req.url)).replace(
              NULL_BYTE_PLACEHOLDER,
              "\0"
            );
            url = removeImportQuery(url);
            // Strip valid id prefix. This is prepended to resolved Ids that are
            // not valid browser import specifiers by the importAnalysis plugin.
            url = unwrapId(url);

            // check if we can return 304 early
            const ifNoneMatch = req.headers["if-none-match"];
            if (
              ifNoneMatch &&
              (await server.moduleGraph.getModuleByUrl(url, false))
                ?.transformResult?.etag === ifNoneMatch
            ) {
              // isDebug && debugCache(`[304] ${prettifyUrl(url, root)}`)
              res.statusCode = 304;
              return res.end();
            }

            // resolve, load and transform using the plugin container
            const result = await server.transformRequest(url, server, {
              html: req.headers.accept?.includes("text/html"),
            });
            if (result) {
              return send(req, res, result.code, "js", {
                etag: result.etag,
                // allow browser to cache npm deps!
                cacheControl: "no-cache",
                headers: server.config.server.headers,
                map: result.map,
              });
            }
          } catch (e) {
            if (e?.code === ERR_OPTIMIZE_DEPS_PROCESSING_ERROR) {
              // Skip if response has already been sent
              if (!res.writableEnded) {
                res.statusCode = 504; // status code request timeout
                res.end();
              }
              // This timeout is unexpected
              logger.error(e.message);
              return;
            }
            if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP) {
              // Skip if response has already been sent
              if (!res.writableEnded) {
                res.statusCode = 504; // status code request timeout
                res.end();
              }
              // We don't need to log an error in this case, the request
              // is outdated because new dependencies were discovered and
              // the new pre-bundle dependencies have changed.
              // A full-page reload has been issued, and these old requests
              // can't be properly fulfilled. This isn't an unexpected
              // error but a normal part of the missing deps discovery flow
              return;
            }
            return next(e);
          }
        }
        next();
      });
    },
  };
}
