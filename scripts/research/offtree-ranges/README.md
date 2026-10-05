# Off-tree villain ranges — option 3 measurement (2026-10-06)

RESEARCH ONLY. Nothing here is loaded by the API, wrapper or chart server. Zero GTO Wizard requests: solver nodes come
from the chain's stored solve traces (poker.sqlite `solves`) and the GTO Wizard node caches.

Pipeline (Python 3.12 + numpy; `S` = any scratch dir):

    python hh_parse.py  $S/hh.pkl                                  # Ignition downloaded histories, every seat's cards
    python extract.py   C:/Users/Brady/poker-data/poker.sqlite $S/acts_live.pkl
    python extract.py   C:/Users/Brady/poker-data-stress500/root/poker.sqlite $S/acts_stress.pkl --origins stress
    python join.py      $S/acts_live.pkl $S/hh.pkl $S/joined.pkl   # villain's real cards, history must agree
    python score.py     $S/hh.pkl $S/joined.pkl $S/score.json $S/items.pkl   # ~2.5 min
    python fit2.py      $S/items.pkl $S/fit2.json
    python build_view.py $S $S/offtree_data.json
    python inject.py    $S/offtree_data.json $S/offtree-ranges.html          # the published page

Published: https://claude.ai/artifact/WghEyAsVA1yNeDjXE2yPcV
