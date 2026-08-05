"""Icon entry point. Imports launch and runs main() — module mode."""
import sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
MARK = HERE / "debug" / "last-start.txt"
try:
    MARK.parent.mkdir(exist_ok=True)
    MARK.write_text("start\n", encoding="utf-8")
    sys.path.insert(0, str(HERE))
    import launch
    with MARK.open("a", encoding="utf-8") as f:
        f.write("imported\n")
    launch.main()
    with MARK.open("a", encoding="utf-8") as f:
        f.write("main returned\n")
except BaseException as e:  # pythonw has nowhere to print — file it
    import traceback
    with MARK.open("a", encoding="utf-8") as f:
        f.write("EXC: " + repr(e) + "\n")
        traceback.print_exc(file=f)
