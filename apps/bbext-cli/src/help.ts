export function printHelp(): void {
  console.log(`bbext - Recursive .bbmodel exporter\n
Usage:
  bbext --input <file-or-folder> --output <destination-folder> [options]
  bbext --manifest <bbext-manifest.json> [options]
  bbext --generate-manifest --input <folder-with-bbmodels> [--manifest <target-manifest.json>] [options]

Options:
  --input, -i       .bbmodel file or root folder for recursive scanning
  --output, -o      Output folder
  --manifest, -m    Manifest JSON with per-model bbmodel/output/textureIndex/ext,
                    modelScale/embedTextures/exportGroupsAsArmature/exportAnimations,
                    and metadata
                    In --generate-manifest mode, this is the output manifest file path
  --generate-manifest
                    Generate a basic manifest by scanning .bbmodel files recursively
  --manifest-name-by
                    Name output files by file-name or model-id (default: file-name)
  --ext, -e         3D object extension (obj, gltf, gltf-three, fbx)
  --scale, -s       Numeric scale applied to the model (default: 0.0625)
  --split-by-texture
                    Export each texture as a separate model file
  --split-by-all-declared-textures, -a
                    Export one file per declared texture, even if unused by faces
  --organize-by-model
                    Create a folder per bbmodel using file-name or model-id
  --model-scale     Model scale for glTF export
  --embed-textures  Embed textures in glTF (data URI when available)
  --export-groups-as-armature
                    Export outliner groups as an armature hierarchy in glTF
  --export-animations
                    Export animations present in the bbmodel to glTF
  --overwrite       Overwrite already converted files
  --clean-output    Clear the destination folder before converting
  --clean-output-godot
                    Keep Godot .import files; clean only generated glTF artifacts
  --json            Print final structured JSON report with correct/wrong arrays
  --help, -h        Show this help

Example:
  bbext -i ./models -o ./exports -e gltf --model-scale 0.0625 --embed-textures --export-groups-as-armature --export-animations --overwrite

Manifest example:
  bbext -m ./bbext.manifest.json --json

Manifest generation example:
  bbext --generate-manifest -i ./models -m ./bbext.manifest.json --manifest-name-by model-id
`);
}
