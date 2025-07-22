import { Plugin } from "vite";
import { parse, type ParserOptions } from "@babel/parser";
import * as esbuild from "esbuild";
import fs from "fs/promises";
import MagicString from "magic-string";
import path from "path";
import resolveConfig from "tailwindcss/resolveConfig.js";
import { findProjectRoot, shouldTagElement } from "./util.js";

const validExtensions = new Set([".jsx", ".tsx"]);
const projectRoot = findProjectRoot();
const tailwindInputFile = path.resolve(projectRoot, "./tailwind.config.ts");
const tailwindJsonOutfile = path.resolve(
  projectRoot,
  "./src/tailwind.config.lov.json"
);
const tailwindIntermediateFile = path.resolve(
  projectRoot,
  "./.lov.tailwind.config.js"
);
const isSandbox = process.env.HANZO_DEV_SERVER === "true";

export function componentTagger(): Plugin {
  const cwd = process.cwd();
  const stats = {
    totalFiles: 0,
    processedFiles: 0,
    totalElements: 0
  };

  return {
    name: "vite-plugin-component-tagger",
    enforce: "pre",
    async transform(code, id) {
      if (!validExtensions.has(path.extname(id)) || id.includes("node_modules")) {
        return null;
      }

      stats.totalFiles++;
      const relativePath = path.relative(cwd, id);

      try {
        const parserOptions: ParserOptions = {
          sourceType: "module",
          plugins: ["jsx", "typescript"]
        };

        const ast = parse(code, parserOptions);
        const magicString = new MagicString(code);
        let changedElementsCount = 0;
        let currentElement: any = null;

        const { walk } = await import("estree-walker");
        walk(ast.program as any, {
          enter(node: any) {
            if (node.type === "JSXElement") {
              currentElement = node;
            }

            if (node.type === "JSXOpeningElement") {
              const jsxNode = node;
              let elementName: string;

              if (jsxNode.name.type === "JSXIdentifier") {
                elementName = jsxNode.name.name;
              } else if (jsxNode.name.type === "JSXMemberExpression") {
                const memberExpr = jsxNode.name;
                elementName = `${memberExpr.object.name}.${memberExpr.property.name}`;
              } else {
                return;
              }

              if (elementName === "Fragment" || elementName === "React.Fragment") {
                return;
              }

              const attributes = jsxNode.attributes.reduce((acc: any, attr: any) => {
                if (attr.type === "JSXAttribute") {
                  if (attr.value?.type === "StringLiteral") {
                    acc[attr.name.name] = attr.value.value;
                  } else if (attr.value?.type === "JSXExpressionContainer" && attr.value.expression.type === "StringLiteral") {
                    acc[attr.name.name] = attr.value.expression.value;
                  }
                }
                return acc;
              }, {});

              let textContent = "";
              if (currentElement && currentElement.children) {
                textContent = currentElement.children.map((child: any) => {
                  if (child.type === "JSXText") {
                    return child.value.trim();
                  } else if (child.type === "JSXExpressionContainer") {
                    if (child.expression.type === "StringLiteral") {
                      return child.expression.value;
                    }
                  }
                  return "";
                }).filter(Boolean).join(" ").trim();
              }

              const content: any = {};
              if (textContent) {
                content.text = textContent;
              }
              if (attributes.placeholder) {
                content.placeholder = attributes.placeholder;
              }
              if (attributes.className) {
                content.className = attributes.className;
              }

              const line = jsxNode.loc?.start?.line ?? 0;
              const col = jsxNode.loc?.start?.column ?? 0;
              const dataComponentId = `${relativePath}:${line}:${col}`;
              const fileName = path.basename(id);
              const shouldTag = shouldTagElement(elementName);

              if (shouldTag) {
                const legacyIds = ` data-component-path="${relativePath}" data-component-line="${line}" data-component-file="${fileName}" data-component-name="${elementName}" data-component-content="${encodeURIComponent(
                  JSON.stringify(content)
                )}"`;

                magicString.appendLeft(
                  jsxNode.name.end ?? 0,
                  ` data-lov-id="${dataComponentId}" data-lov-name="${elementName}" ${legacyIds}`
                );
                changedElementsCount++;
              }
            }
          }
        });

        stats.processedFiles++;
        stats.totalElements += changedElementsCount;

        return {
          code: magicString.toString(),
          map: magicString.generateMap({ hires: true })
        };
      } catch (error) {
        console.error(`Error processing file ${relativePath}:`, error);
        stats.processedFiles++;
        return null;
      }
    },

    async buildStart() {
      if (!isSandbox) return;
      try {
        await generateConfig();
      } catch (error) {
        console.error("Error generating tailwind.config.lov.json:", error);
      }
    },

    configureServer(server) {
      if (!isSandbox) return;
      try {
        server.watcher.add(tailwindInputFile);
        server.watcher.on("change", async (changedPath) => {
          if (path.normalize(changedPath) === path.normalize(tailwindInputFile)) {
            await generateConfig();
          }
        });
      } catch (error) {
        console.error("Error adding watcher:", error);
      }
    }
  };
}

async function generateConfig() {
  try {
    await esbuild.build({
      entryPoints: [tailwindInputFile],
      outfile: tailwindIntermediateFile,
      bundle: true,
      format: "esm",
      banner: {
        js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);'
      }
    });

    try {
      const userConfig = await import(
        tailwindIntermediateFile + "?update=" + Date.now()
      );

      if (!userConfig || !userConfig.default) {
        console.error("Invalid Tailwind config structure:", userConfig);
        throw new Error("Invalid Tailwind config structure");
      }

      const resolvedConfig = resolveConfig(userConfig.default);
      await fs.writeFile(
        tailwindJsonOutfile,
        JSON.stringify(resolvedConfig, null, 2)
      );

      await fs.unlink(tailwindIntermediateFile).catch(() => {});
    } catch (error) {
      console.error("Error processing config:", error);
      throw error;
    }
  } catch (error) {
    console.error("Error in generateConfig:", error);
    throw error;
  }
}