# -*- coding: utf-8 -*-
"""`scripts/` 作为一个**包**。

## 为什么需要这个 `__init__.py`

Python 的 **site-packages 里有一个叫 `scripts` 的包**（很多工具装的）。
没有这个 `__init__.py` 时，本目录只是一个**命名空间包**，
而**命名空间包输给普通包** —— 于是：

    import scripts.standard_pack
    → ModuleNotFoundError: No module named 'scripts.standard_pack'
    （它找到了 site-packages 那个 scripts）

症状很有欺骗性：**在别的机器上好好的**（那里没装那个包），
在装了它的机器上就找不到自己的模块。

加上这个文件，本目录就成了**普通包**，
而仓库根在 sys.path[0] —— 优先于 site-packages ✓。
"""
