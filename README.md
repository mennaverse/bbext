# bbext

A TSX CLI for recursively exporting `.bbmodel` files to 3D output formats.

Currently supported output formats:

- `.obj` (with `.mtl` and extracted textures when available)
- `.gltf` (with `.bin` and textures in a companion folder)
- `.gltf-three` (same `.gltf` payload as the canonical exporter, kept as a compatibility target)
- `.fbx` (ASCII FBX focused on geometry and UVs)

## Structure

- `apps/bbext-cli`: command-line application
- `packages/bbext-lib`: reading and export library

## Requirements

- pnpm
- tsx

## Install dependencies

```bash
pnpm install
```

## Run in dev mode

```bash
pnpm run dev --cwd apps/bbext-cli -- --help
```

## Usage

```bash
bbext --input <file-or-folder> --output <destination-folder> [options]
bbext --manifest <bbext-manifest.json> [--output <destination-folder>] [options]
bbext --generate-manifest --input <folder-with-bbmodels> [--manifest <target-manifest.json>] [options]
```

Options:

- `--input, -i`: `.bbmodel` file or folder for recursive scanning
- `--output, -o`: output folder
- `--manifest, -m`: manifest JSON for per-model configuration
- `--generate-manifest`: generate a basic manifest by scanning `.bbmodel` files recursively
- `--manifest-name-by`: choose generated output naming using `file-name` or `model-id` (default `file-name`)
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
- `--clean-output`: clear destination folder before conversion (flag, default `false`)
- `--clean-output-godot`: preserve Godot `.import` files while cleaning generated glTF artifacts
- `--json`: print final execution report as JSON with `correct` and `wrong` arrays

Example:

```bash
bbext -i ./models -o ./exports -e obj --scale 0.0625 --overwrite
```

glTF example with Blockbench-style options:

```bash
bbext -i ./models -o ./exports -e gltf --model-scale 0.0625 --embed-textures --export-groups-as-armature --export-animations --overwrite
```

glTF example using the `gltf-three` compatibility target:

```bash
bbext -i ./models -o ./exports -e gltf-three --model-scale 0.0625 --embed-textures --export-groups-as-armature --export-animations --overwrite
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

## Manifest mode

Use a manifest file to configure each model independently.

Example `bbext.manifest.json`:

```json
{
	"version": 1,
	"models": [
		{
			"bbmodel": "models/character.bbmodel",
			"output": "exports/character.gltf",
			"textureIndex": 0,
			"modelScale": 0.0625,
			"embedTextures": true,
			"exportGroupsAsArmature": true,
			"exportAnimations": true,
			"metadata": {
				"asset": "character",
				"lod": 0
			}
		},
		{
			"bbmodel": "models/weapon.bbmodel",
			"output": "exports/weapon.obj",
			"textureIndex": 1,
			"ext": "obj",
			"metadata": {
				"asset": "weapon",
				"variant": "iron"
			}
		}
	]
}
```

## Generate manifest automatically

Generate a basic manifest from a folder full of `.bbmodel` files:

```bash
bbext --generate-manifest -i ./models -m ./bbext.manifest.json
```

Generated entries follow this baseline:

- `bbmodel`: relative path to the `.bbmodel`
- `output`: `exported/%s.gltf`, where `%s` is derived from `file-name` by default
- `modelScale`: `0.0625`
- `embedTextures`: `false`
- `exportGroupsAsArmature`: `false`
- `exportAnimations`: `false`
- `metadata`: empty object `{}`

To derive `%s` from `model-id` when available:

```bash
bbext --generate-manifest -i ./models -m ./bbext.manifest.json --manifest-name-by model-id
```

If `model-id` is missing in a model, generation falls back to the file name.

Fields per item:

- `bbmodel`: relative path to the source `.bbmodel` (relative to the manifest file)
- `output`: destination file path (relative to manifest folder, or to `--output` if provided)
- `textureIndex`: optional 0-based index that pins the export to a single texture from the model's texture list. When omitted, all textures are exported (split by texture). When set, only the texture at that index is used and the output file path is used exactly as declared (no per-texture suffix is appended).
- `ext`: optional output extension override (`obj`, `gltf`, `gltf-three`, `fbx`)
- `modelScale`: optional glTF scale override for this model (positive number)
- `embedTextures`: optional glTF toggle to embed textures for this model
- `exportGroupsAsArmature`: optional glTF toggle to export outliner groups as armature for this model
- `exportAnimations`: optional glTF toggle to export animations for this model
- `metadata`: optional metadata payload (returned as JSON text in `--json` mode)

When a glTF field is present in a manifest item, it overrides the corresponding CLI option for that item.

Run:

```bash
bbext --manifest ./bbext.manifest.json --json
```

Example JSON result:

```json
{
	"correct": [
		{
			"model": "models/character.bbmodel",
			"output": "exports/character.gltf",
			"metadata": {"asset": "character", "lod": 0},
			"exported": [
				"C:/path/to/exports/character.gltf"
			]
		}
	],
	"wrong": [
		{
			"model": "models/missing.bbmodel",
			"output": "exports/missing.gltf",
			"metadata": {"asset": "missing"},
			"exported": [],
			"error": "ENOENT: no such file or directory ..."
		}
	]
}
```
