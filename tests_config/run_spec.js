"use strict";

const spawnSync = require("child_process").spawnSync;
const fs = require("fs");
const extname = require("path").extname;
const prettier = require("prettier");
const massageAST = require("prettier/src/common/clean-ast").massageAST;
const normalizeOptions = require("prettier/src/main/options").normalize;
const semver = require("semver");

const AST_COMPARE = process.env.AST_COMPARE;

function getPythonBinAndVersion(potentialBins, versionSpec) {
  for (let i = 0; i < potentialBins.length; i++) {
    let bin = potentialBins[i];

    const proc = spawnSync(bin, ["-c", "import platform; print(platform.python_version())"]);
    if (proc.status !== 0) {
      continue;
    }
    const version = proc.stdout.toString().trim();

    if (version !== null && semver.satisfies(version, versionSpec)) {
      return [bin, version];
    }
  }

  return null;
}

const python2BinAndVersion = getPythonBinAndVersion(["python2.7", "python2", "python"], "2.*");
const python3BinAndVersion = getPythonBinAndVersion(["python3.6", "python3", "python"], "3.*");

function getPythonBinaries(versionSpec) {
  // Try to find a python2 and python3 binary
  let pythonBinaries = [];
  [python2BinAndVersion, python3BinAndVersion].forEach((binAndVersion) => {
    if (binAndVersion !== null) {
      const [bin, version] = binAndVersion;
      if (semver.satisfies(version, versionSpec)) {
        pythonBinaries.push(bin);
      }
    }
  });

  test("At least one valid Python version", () => {
    expect(pythonBinaries.length).toBeGreaterThan(0);
  });
  if (versionSpec === "*") {
    test("Both Python versions available", () => {
      expect(pythonBinaries.length).toEqual(2);
    });
  }

  return pythonBinaries;
}

function run_spec(dirname, parsers, versionRange, options) {
  options = Object.assign(
    {
      plugins: ["."]
    },
    options
  );

  /* instabul ignore if */
  if (!parsers || !parsers.length) {
    throw new Error(`No parsers were specified for ${dirname}`);
  }

  fs.readdirSync(dirname).forEach(filename => {
    const path = dirname + "/" + filename;
    if (
      extname(filename) !== ".snap" &&
      fs.lstatSync(path).isFile() &&
      filename[0] !== "." &&
      filename !== "jsfmt.spec.js"
    ) {
      const source = read(path).replace(/\r\n/g, "\n");

      getPythonBinaries(versionRange).forEach((pythonBin) => {
        const mergedOptions = Object.assign({}, options, {
          parser: parsers[0],
          pythonBin: pythonBin
        });
        const output = prettyprint(source, path, mergedOptions);
        test(`${filename} - ${mergedOptions.parser}-verify`, () => {
          expect(raw(source + "~".repeat(80) + "\n" + output)).toMatchSnapshot(
            filename
          );
        });

        parsers.slice(1).forEach(parserName => {
          test(`${filename} - ${parserName}-verify`, () => {
            const verifyOptions = Object.assign(mergedOptions, {
              parser: parserName
            });
            const verifyOutput = prettyprint(source, path, verifyOptions);
            expect(output).toEqual(verifyOutput);
          });
        });

        if (AST_COMPARE) {
          const ast = parse(source, mergedOptions);
          const normalizedOptions = normalizeOptions(mergedOptions);
          const astMassaged = massageAST(ast, normalizedOptions);
          let ppastMassaged;
          let pperr = null;
          try {
            const ppast = parse(
              prettyprint(source, path, mergedOptions),
              mergedOptions
            );
            ppastMassaged = massageAST(ppast, normalizedOptions);
          } catch (e) {
            pperr = e.stack;
          }

          test(path + " parse", () => {
            expect(pperr).toBe(null);
            expect(ppastMassaged).toBeDefined();
            if (!ast.errors || ast.errors.length === 0) {
              expect(astMassaged).toEqual(ppastMassaged);
            }
          });
        }
      });
    }
  });
}
global.run_spec = run_spec;

/**
 * This gets rid of extra keys not removed by the massageAST function which are not suitable or relevant when
 * comparing two different ASTs.
 */
function stripExtraNonComparableKeys(ast) {
  if (Array.isArray(ast)) {
    return ast.map(e => stripExtraNonComparableKeys(e));
  }
  if (typeof ast === "object") {
    const newObj = {};
    for (const key in ast) {
      if (key === "text") {
        continue;
      }
      newObj[key] = stripExtraNonComparableKeys(ast[key]);
    }
    return newObj;
  }
  return ast;
}

function parse(string, opts) {
  return stripExtraNonComparableKeys(prettier.__debug.parse(string, opts));
}

function prettyprint(src, filename, options) {
  return prettier.format(
    src,
    Object.assign(
      {
        filepath: filename
      },
      options
    )
  );
}

function read(filename) {
  return fs.readFileSync(filename, "utf8");
}

/**
 * Wraps a string in a marker object that is used by `./raw-serializer.js` to
 * directly print that string in a snapshot without escaping all double quotes.
 * Backticks will still be escaped.
 */
function raw(string) {
  if (typeof string !== "string") {
    throw new Error("Raw snapshots have to be strings.");
  }
  return { [Symbol.for("raw")]: string };
}
