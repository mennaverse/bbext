# bbext

A Bun + TypeScript CLI for recursively exporting `.bbmodel` files to 3D output formats.

Currently supported output formats:

- `.obj` (with `.mtl` and extracted textures when available)
- `.gltf` (with `.bin` and textures in a companion folder)
- `.gltf-three` (generated with Three.js `GLTFExporter` via `node-three-gltf`)
- `.fbx` (ASCII FBX focused on geometry and UVs)

## Structure

- `apps/bbext-cli`: command-line application
- `packages/bbext-lib`: reading and export library

## Requirements

- Bun 1.x

## Install dependencies

```bash
bun install
```

## Run in dev mode

```bash
bun run dev --cwd apps/bbext-cli -- --help
```

## Build the CLI with Bun

Generates a compiled binary at `apps/bbext-cli/dist/bbext`:

```bash
bun run build
```

Or directly from the CLI package:

```bash
bun run --cwd apps/bbext-cli build
```

## Build a single .exe (alternative packager)

If you need one standalone `.exe` that works from any `cwd`, use the pkg-based build:

```bash
bun run build:single
```

Output:

- `apps/bbext-cli/dist/bbext-single.exe`

This path keeps Bun for development and conversion code, but uses `pkg` only for final Windows single-file packaging.

## Usage

```bash
bbext --input <file-or-folder> --output <destination-folder> [options]
```

Options:

- `--input, -i`: `.bbmodel` file or folder for recursive scanning
- `--output, -o`: output folder
- `--ext, -e`: export extension (`obj`, `gltf`, `gltf-three`, `fbx`)
- `--scale, -s`: applied scale (default `0.0625`)
- `--split-by-texture`: export each texture as a separate model file
- `--split-by-all-declared-textures, -a`: export one file per declared texture, even if unused by faces
- `--organize-by-model`: create one folder per `.bbmodel` using `file-name` or `model-id`
- `--model-scale`: model scale for glTF
- `--embed-textures`: embed textures in glTF when available
- `--export-groups-as-armature`: export outliner groups as an armature in glTF
- `--export-animations`: export animations to glTF
- `--overwrite`: overwrite existing files

Example:

```bash
bbext -i ./models -o ./exports -e obj --scale 0.0625 --overwrite
```

glTF example with Blockbench-style options:

```bash
bbext -i ./models -o ./exports -e gltf --model-scale 0.0625 --embed-textures --export-groups-as-armature --export-animations --overwrite
```

glTF example using Three.js exporter (`node-three-gltf`):

```bash
bbext -i ./models -o ./exports -e gltf-three --model-scale 0.0625 --embed-textures --overwrite
```

Split one `.bbmodel` into one output file per texture:

```bash
bbext -i ./models -o ./exports -e obj --split-by-texture --overwrite
```

When `--split-by-texture` is enabled, output files receive a texture suffix such as `character__skin.obj` or `character__metal.gltf`.

Split one `.bbmodel` into one output file for every declared texture:

```bash
bbext -i ./models -o ./exports -e gltf -a --overwrite
```

Organize each exported model inside its own folder:

```bash
bbext -i ./models -o ./exports -e gltf --organize-by-model file-name --overwrite
```

Or organize by the model identifier when available:

```bash
bbext -i ./models -o ./exports -e gltf --organize-by-model model-id --overwrite
```

When `--organize-by-model model-id` is used and the model has no explicit ID, the exporter falls back to the source file name.

## Export flow

1. Finds all `.bbmodel` files under the input path recursively.
2. Preserves the folder hierarchy in the output.
3. Converts each model to the requested output format.
4. Generates companion files when required, such as `.mtl` or `.bin`.
5. Extracts embedded textures and copies external textures when needed.
