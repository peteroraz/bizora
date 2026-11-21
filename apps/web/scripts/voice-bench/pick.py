# Picks one clip per speaker from OpenSLR SLR70 (Nigerian English, CC BY-SA 4.0) for the voice benchmark.
import csv, os, subprocess, sys
out = sys.argv[1]
per_gender = int(sys.argv[2]) if len(sys.argv) > 2 else 25
index = []
for gender in ("female", "male"):
    seen = set()
    rows = [line.rstrip("\n").split("\t") for line in open(os.path.join(out, f"line_index_{gender}.tsv"), encoding="utf-8") if "\t" in line]
    chosen = []
    for file_id, text in rows:
        speaker = "_".join(file_id.split("_")[:2])
        if speaker in seen or len(text.split()) < 5:
            continue
        seen.add(speaker)
        chosen.append((file_id, text.strip()))
        if len(chosen) == per_gender:
            break
    names = [f"{file_id}.wav" for file_id, _ in chosen]
    listing = subprocess.run(["unzip", "-Z1", os.path.join(out, f"{gender}.zip")], capture_output=True, text=True, check=True).stdout.split()
    paths = [path for path in listing if os.path.basename(path) in names]
    subprocess.run(["unzip", "-q", "-j", "-o", os.path.join(out, f"{gender}.zip"), *paths, "-d", out], check=True)
    index += [f"{file_id}.wav\t{text}" for file_id, text in chosen if os.path.exists(os.path.join(out, f"{file_id}.wav"))]
open(os.path.join(out, "index.tsv"), "w", encoding="utf-8").write("\n".join(index) + "\n")
print(f"{len(index)} Nigerian English clips")
