"""Embed the data JSON into view.html -> the publishable page.   python inject.py <data.json> <out.html>"""
import sys

tpl = open(__file__.replace("inject.py", "view.html"), encoding="utf-8").read()
data = open(sys.argv[1], encoding="utf-8").read().replace("</", "<\\/")   # keep "</script>" out of the inline JSON
open(sys.argv[2], "w", encoding="utf-8").write(tpl.replace("/*DATA*/", data))
