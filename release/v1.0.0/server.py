"""
深度挖掘 · 云端发动机 v12.0
============================
Phase 1: 对话式投研分析师 + 左/右栏解耦 + OB直写
Phase 2: 卡片分层 + 治理评分 + 概念卡自动提取 + 搜索词优化
启动: python3 -m uvicorn server:app --host 0.0.0.0 --port 8000
"""

import os, json, hashlib, uuid, logging, sys, re, subprocess, shutil
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional
import pandas as pd

from fastapi import FastAPI, HTTPException, Request, Depends, Query
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import jwt

BASE_DIR     = Path("/home/admin/deepdig")
DATA_DIR     = BASE_DIR / "data"; LOG_DIR = BASE_DIR / "logs"
STATIC_DIR   = BASE_DIR / "static"; PIPELINE_DIR = BASE_DIR / "pipeline"
CARD_DIR     = DATA_DIR / "cards"

for d in [DATA_DIR, LOG_DIR, CARD_DIR]: d.mkdir(parents=True, exist_ok=True)

JWT_SECRET     = os.environ.get("DEEPDIG_JWT_SECRET", "beaver-deepdig-2026-prod")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "deepdig2026")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.FileHandler(LOG_DIR/"server.log"), logging.StreamHandler(sys.stdout)])
log = logging.getLogger("deepdig")

app = FastAPI(title="深度挖掘", version="12.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ═══════════ 数据模型 ═══════════
class AuthRequest(BaseModel): email: str; password: str; ds_key: Optional[str] = None
class ChatRequest(BaseModel): message: str; history: list = []
class KeyUpdate(BaseModel): ds_key: str; obsidian_path: Optional[str] = None
class PaymentRequest(BaseModel): method: str = "alipay"; plan: str = "monthly"

# ═══════════ 用户存储 ═══════════
USER_FILE = DATA_DIR / "users.json"
def _load_users() -> dict: return json.loads(USER_FILE.read_text("utf-8")) if USER_FILE.exists() else {}
def _save_users(d: dict): USER_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
def _hash_pw(pw: str, salt: str) -> str: return hashlib.sha256((pw+salt).encode()).hexdigest()
def _seed():
    users = _load_users()
    if "admin" not in users:
        s = uuid.uuid4().hex
        users["admin"] = {"email":"admin","password_hash":_hash_pw(ADMIN_PASSWORD,s),"salt":s,
            "ds_key":None,"obsidian_path":"","plan":"paid","plan_expires":None,
            "quota_deep":99999,"quota_quick":99999,"created":datetime.now().isoformat(),"role":"admin"}
        _save_users(users)
_seed()

# ═══════════ JWT ═══════════
def _make_token(email: str) -> str:
    return jwt.encode({"email":email,"exp":datetime.utcnow()+timedelta(days=30)}, JWT_SECRET, algorithm="HS256")
def _verify_token(token: str) -> Optional[str]:
    try: return jwt.decode(token, JWT_SECRET, algorithms=["HS256"]).get("email")
    except: return None
async def _require_user(request: Request) -> dict:
    auth = request.headers.get("Authorization","")
    if not auth: raise HTTPException(401, "未携带认证信息")
    if not auth.startswith("Bearer "): raise HTTPException(401, "认证格式错误")
    email = _verify_token(auth[7:])
    if not email: raise HTTPException(401, "登录已过期")
    user = _load_users().get(email)
    if not user: raise HTTPException(401, "用户不存在")
    return user
async def _require_admin(user: dict = Depends(_require_user)):
    if user.get("role") != "admin": raise HTTPException(403, "仅管理员")
    return user

def _safe_user(u: dict) -> dict:
    safe = {k:v for k,v in u.items() if k not in ("password_hash","salt")}
    key = safe.get("ds_key") or ""
    if len(key) > 8: safe["ds_key_masked"] = key[:4] + "*"*(len(key)-8) + key[-4:]
    else: safe["ds_key_masked"] = key[:4]+"****" if len(key) > 4 else key
    return safe

# ═══════════ Auth API ═══════════
@app.post("/api/register")
def api_register(req: AuthRequest):
    if not req.email or not req.password: raise HTTPException(400, "邮箱和密码不能为空")
    if len(req.password) < 6: raise HTTPException(400, "密码至少6位")
    users = _load_users()
    if req.email in users: raise HTTPException(400, "该邮箱已注册")
    s = uuid.uuid4().hex
    trial_end = datetime.now() + timedelta(days=7)
    u = {"email":req.email,"password_hash":_hash_pw(req.password,s),"salt":s,
         "ds_key":req.ds_key or None,"obsidian_path":"","plan":"trial",
         "plan_expires":trial_end.isoformat(),
         "auto_renew":False,"cancel_at":None,
         "quota_deep":99999,"quota_quick":99999,"created":datetime.now().isoformat(),"role":"user"}
    users[req.email]=u; _save_users(users)
    log.info(f"注册: {req.email}")
    return {"token":_make_token(req.email),"user":_safe_user(u)}

@app.post("/api/login")
def api_login(req: AuthRequest):
    users=_load_users(); u=users.get(req.email)
    if not u: raise HTTPException(401, "账号不存在")
    if _hash_pw(req.password,u["salt"]) != u["password_hash"]: raise HTTPException(401, "密码错误")
    log.info(f"登录: {req.email}")
    return {"token":_make_token(req.email),"user":_safe_user(u)}

@app.get("/api/user/me")
def api_me(user=Depends(_require_user)):
    safe = _safe_user(user)
    # 附加订阅状态
    now = datetime.now()
    expires = user.get("plan_expires")
    expires_dt = datetime.fromisoformat(expires) if expires else None
    safe["subscription"] = {
        "plan": user.get("plan","trial"),
        "plan_name": PLANS.get(user.get("plan","trial"), {}).get("name", "未知"),
        "status": "active" if (expires_dt and expires_dt > now) else "expired",
        "expires": expires,
        "days_left": max(0, (expires_dt - now).days) if expires_dt else 0,
        "auto_renew": user.get("auto_renew", False),
        "trial": user.get("plan") == "trial",
    }
    return safe

@app.put("/api/user/key")
def api_update_key(req: KeyUpdate, user=Depends(_require_user)):
    users=_load_users()
    users[user["email"]]["ds_key"]=req.ds_key
    if req.obsidian_path is not None: users[user["email"]]["obsidian_path"]=req.obsidian_path
    _save_users(users); return {"status":"ok"}

# ═══════════ WebSearch ═══════════
def _run_search(query: str, num: int = 5) -> str:
    try:
        import urllib.request, urllib.parse
        q = urllib.parse.quote(query)
        url = f"https://html.duckduckgo.com/html/?q={q}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode("utf-8", errors="replace")
        results = []
        from html.parser import HTMLParser
        class P(HTMLParser):
            def __init__(self):
                super().__init__(); self.res=[]; self.cur={}; self.intag=False
            def handle_starttag(self, tag, attrs):
                d = dict(attrs)
                if tag=="a" and "result__a" in d.get("class",""):
                    self.intag=True; self.cur={"title":"","url":d.get("href",""),"snippet":""}
            def handle_data(self, data):
                if self.intag and not self.cur["title"]: self.cur["title"]=data.strip()[:120]
            def handle_endtag(self, tag):
                if self.intag and tag=="a":
                    if self.cur["title"]: self.res.append(self.cur)
                    self.intag=False; self.cur={}
        P().feed(html)
        if not P().res: return ""
        out = []
        for i, r in enumerate(P().res[:num]):
            out.append(f"{i+1}. **{r['title']}**\n   {r.get('url','')}")
        return "\n\n".join(out)
    except Exception as e:
        log.warning(f"搜索失败: {e}"); return ""

# ═══════════ Admin ═══════════
@app.get("/admin/users")
def admin_users(user=Depends(_require_admin)):
    return [{"email":u["email"],"plan":u.get("plan","trial"),"plan_expires":u.get("plan_expires"),
             "role":u.get("role","user"),"created":u.get("created"),"has_ds_key":bool(u.get("ds_key"))}
            for u in _load_users().values()]
@app.put("/admin/users/{email}/plan")
def admin_set_plan(email: str, plan: str = Query("paid"), user=Depends(_require_admin)):
    users = _load_users()
    if email not in users: raise HTTPException(404)
    users[email]["plan"] = plan
    users[email]["plan_expires"] = None if plan == "paid" else (datetime.now()+timedelta(days=3)).isoformat()
    if plan == "paid": users[email]["quota_deep"] = 99999; users[email]["quota_quick"] = 99999
    _save_users(users); return {"status":"ok"}
@app.get("/admin/stats")
def admin_stats(user=Depends(_require_admin)):
    users=_load_users(); paid=sum(1 for u in users.values() if u.get("plan")=="paid")
    return {"total_users":len(users),"paid_users":paid,"trial_users":len(users)-paid,"monthly_revenue":paid*99}
@app.get("/api/reports")
def api_reports(user=Depends(_require_user)):
    reports_file = DATA_DIR / "reports.json"
    reports = json.loads(reports_file.read_text("utf-8")) if reports_file.exists() else []
    email=user["email"]
    mine=reports if user.get("role")=="admin" else [r for r in reports if r.get("user")==email]
    return [{"id":r["id"],"title":r["title"],"entity":r["entity"],"date":r["date"]} for r in mine[:50]]
@app.get("/api/health")
def health(): return {"status":"ok","time":datetime.now().isoformat(),"users":len(_load_users())}

# ═══════════ 静态前端 ═══════════
FRONTEND_DIR = BASE_DIR / "frontend"
if FRONTEND_DIR.exists():
    @app.get("/")
    async def serve_index():
        from fastapi.responses import FileResponse
        return FileResponse(FRONTEND_DIR / "user.html")

    @app.get("/{filename}.html")
    async def serve_html(filename: str):
        from fastapi.responses import FileResponse
        fp = FRONTEND_DIR / f"{filename}.html"
        if fp.exists(): return FileResponse(fp)
        raise HTTPException(404)
@app.post("/api/payment/request")
def api_payment_request(req: PaymentRequest, user=Depends(_require_user)):
    """创建支付订单"""
    plan_config = {
        "monthly":    {"name":"月付套餐","price":6800,"period":"month"},
        "continuous": {"name":"连续包月","price":4800,"period":"month","auto_renew":True},
        "yearly":     {"name":"年付套餐","price":48800,"period":"year"},
    }
    cfg = plan_config.get(req.plan)
    if not cfg: raise HTTPException(400, "无效套餐")
    order_id = f"DD-{datetime.now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6].upper()}"
    order = {
        "order_id":order_id,"email":user["email"],"plan":req.plan,
        "plan_name":cfg["name"],"amount":cfg["price"],"period":cfg["period"],
        "auto_renew":cfg.get("auto_renew",False),
        "method":req.method,"status":"pending","created":datetime.now().isoformat()
    }
    orders = json.loads((DATA_DIR/"orders.json").read_text("utf-8")) if (DATA_DIR/"orders.json").exists() else []
    orders.append(order)
    (DATA_DIR/"orders.json").write_text(json.dumps(orders,ensure_ascii=False,indent=2),encoding="utf-8")
    log.info(f"订单创建: {order_id} | {user['email']} | {cfg['name']} | ¥{cfg['price']/100:.0f}")
    return {"order_id":order_id,"amount":cfg["price"],"status":"pending"}

# ═══════════ 订阅管理（商业版 v1.0） ═══════════

PLANS = {
    "monthly":    {"name":"月付套餐","price":6800,"price_display":"¥68","period":"month","auto_renew":False},
    "continuous": {"name":"连续包月","price":4800,"price_display":"¥48/月·自动续费","period":"month","auto_renew":True},
    "yearly":     {"name":"年付套餐","price":48800,"price_display":"¥488/年","period":"year","auto_renew":False},
    "trial":      {"name":"7天免费试用","price":0,"price_display":"¥0","period":"trial","auto_renew":False},
}

def _activate_subscription(user: dict, plan_key: str):
    """激活套餐"""
    cfg = PLANS[plan_key]
    now = datetime.now()
    if plan_key == "trial":
        user["plan_expires"] = (now + timedelta(days=7)).isoformat()
    elif cfg["period"] == "month":
        user["plan_expires"] = (now + timedelta(days=30)).isoformat()
    elif cfg["period"] == "year":
        user["plan_expires"] = (now + timedelta(days=365)).isoformat()
    user["plan"] = plan_key
    user["auto_renew"] = cfg.get("auto_renew", False)
    user["cancel_at"] = None
    user["quota_deep"] = 99999
    user["quota_quick"] = 99999

@app.post("/api/payment/callback")
def api_payment_callback(order_id: str = Query(...), status: str = Query("paid")):
    """支付回调——支付宝/微信异步通知"""
    orders_file = DATA_DIR / "orders.json"
    if not orders_file.exists(): raise HTTPException(404, "订单不存在")
    orders = json.loads(orders_file.read_text("utf-8"))
    order = next((o for o in orders if o["order_id"] == order_id), None)
    if not order: raise HTTPException(404, "订单不存在")
    if status == "paid":
        order["status"] = "paid"; order["paid_at"] = datetime.now().isoformat()
        orders_file.write_text(json.dumps(orders, ensure_ascii=False, indent=2), encoding="utf-8")
        users = _load_users()
        user = users.get(order["email"])
        if user:
            _activate_subscription(user, order["plan"])
            _save_users(users)
        log.info(f"支付成功: {order_id} | {order['email']} | {PLANS[order['plan']]['name']}")
    return {"status":"ok"}

@app.get("/api/subscription-status")
def api_subscription_status(user=Depends(_require_user)):
    """查询当前订阅状态"""
    now = datetime.now()
    expires = user.get("plan_expires")
    expires_dt = datetime.fromisoformat(expires) if expires else None
    is_active = expires_dt and expires_dt > now
    plan = user.get("plan","trial")
    days_left = (expires_dt - now).days if expires_dt else 0
    return {
        "plan": plan,
        "plan_name": PLANS.get(plan, {}).get("name", "未知"),
        "status": "active" if is_active else "expired",
        "expires": expires,
        "days_left": max(0, days_left),
        "auto_renew": user.get("auto_renew", False),
        "trial": plan == "trial",
    }

@app.post("/api/verify-subscription")
def api_verify_subscription(request: Request):
    """CC 插件调用·验证订阅（使用 JWT Bearer Token）"""
    auth = request.headers.get("Authorization","")
    if not auth or not auth.startswith("Bearer "):
        raise HTTPException(401, "未授权")
    email = _verify_token(auth[7:])
    if not email: raise HTTPException(401, "Token 无效或已过期")
    users = _load_users()
    user = users.get(email)
    if not user: raise HTTPException(401, "用户不存在")
    now = datetime.now()
    expires = user.get("plan_expires")
    expires_dt = datetime.fromisoformat(expires) if expires else None
    is_active = expires_dt and expires_dt > now
    days_left = (expires_dt - now).days if expires_dt else 0
    plan = user.get("plan","trial")
    return {
        "status": "active" if is_active else "expired",
        "plan": plan,
        "plan_name": PLANS.get(plan, {}).get("name", "未知"),
        "days_left": max(0, days_left),
        "trial": plan == "trial",
        "expires": expires,
        "auto_renew": user.get("auto_renew", False),
    }

@app.post("/api/cancel-auto-renew")
def api_cancel_auto_renew(user=Depends(_require_user)):
    """取消自动续费"""
    users = _load_users()
    users[user["email"]]["auto_renew"] = False
    users[user["email"]]["cancel_at"] = datetime.now().isoformat()
    _save_users(users)
    log.info(f"取消自动续费: {user['email']}")
    return {"status":"ok","message":"自动续费已取消。当前套餐到期后不再扣款。"}

# ═══════════ SYSTEM PROMPT v11.0 — 对话式 ═══════════

SYSTEM_PROMPT = """你是「深度挖掘」——一个经验丰富的投研分析师。

## 交流风格

你是在和用户对话，不是在提交报告。用专业但自然的语言。有数据、有判断、有深度。

## 分析方式

你脑中有投资思想框架（护城河、安全边际、逆向思维、周期感等），但**不要**在回复中写成"巴菲特视角（护城河）：…"或"段永平视角（买公司）：…"。把框架内化，用自己的判断语言输出。

**框架是你的内功，不是你的输出模板。** 不要为了展示框架而套框架。只有当一个框架能给出真正犀利的判断时才用——用你自己的话说出来。

## 硬边界

❌ 不推荐股票 · 不给买卖建议 · 不预测涨跌 · 不设目标价

## 输出前自检（在脑中完成，不输出为列表）

回答每个问题时，心里先过一遍这四件事：
1. 我引用的数字有来源吗？没有来源的→诚实说"暂未获取到该数据"
2. 同一指标在回答中是否数值一致？如果财务数据管道拉取成功→优先用管道数据。管道失败→声明"以下基于AI训练记忆，请以公司最新公告为准"
3. 我有没有说过"大概率""可能""或许"？→有的话，要么补充依据，要么删掉
4. 报告结构适宜吗？深度分析→充分展开。轻量追问→简洁有力

## 卡片生长阶段

你生成的知识卡片系统会自动标记为 seed（种子）。当用户后续追问该公司的更多维度时，卡片会自然生长为 seed（种子）→ growing（生长）→ mature（成熟）→ linked（关联）。在对话中你可提及此生命周期，帮助用户理解知识积累的进度。

## 治理评分

在分析具体公司时，顺便给出治理质量评分（0-100）和一句话依据。参考维度：管理费率vs行业、关联交易、实控人质押、审计意见、高管变动。输出格式例：治理评分 62/100，主要扣分项为GE减持和三位高管同日辞职。

## 估值分位

如果用户消息中附带了管道拉取的估值分位数据（PE/PB分位），请优先引用。如果管道数据中不含估值分位——请基于内置知识给出大致判断并标注"基于内置知识，请用户验证"。

## 政策传导链

分析政策时，在回复末尾附一段"政策→产业→公司"的简化传导路径，列出受益行业和时间窗口。

## 治理预警

如果某家公司的治理风险明显偏高（评分<40），请在分析中醒目标注⚠️预警。

## 追问引导

每次深度分析结束时，基于当前话题推荐1-2个追问方向。推荐逻辑：①往上一级（公司→行业）或往下一级（行业→公司）；②如果已有该公司的历史卡片，推荐对比或展开未覆盖的维度。

## 数据诚实——最高优先级

- 管道拉取的实时数据（优先使用）→标注"AKShare管道"
- 搜索获取的最新数据→标注"实时搜索，时间"
- AI训练数据（最后手段）→标注"基于内置知识，截至2025年，请用户验证"
- 绝对不编造。宁可说"这个数字需要进一步查询"

## 格式

- 数字加粗、带单位
- 比较类信息用表。短段≤4行。段落间空一行
- 符号：🔴🟡🟢
- **提到任何上市公司时，务必在名称后附上6位股票代码**。例："力诺药包(301188)"、"宁德时代(300750)"。如果不确定代码，写"（代码待查）"。这一条是强制要求——系统需要代码来生成知识卡片。

## 知识卡片

深度分析末尾生成。如果你分析中提到的公司用户之前已分析过（查看上文"用户已有知识卡片"），请指明"该信息可补充到已有卡片 [[公司名]]"，不要求生成全新卡片。

格式如下：
---
📇 知识卡片
- 标的：[名称·代码]
- 定位：[一句话]
- 关键数字：[3-5个带单位]
- 核心风险：[一项]
---

在你的分析末尾，如果出现了值得关注的新概念（新技术、新赛道、新术语），请额外列出一行：
🔑 新概念：概念名1，概念名2

---
{user_context}
{search_context}
"""

def _build_system_prompt(user_cards: str = "", search_data: str = "") -> str:
    ctx = f"用户已有知识卡片：\n{user_cards[:1200]}" if user_cards else ""
    sch = f"\n\n## 实时搜索数据（{datetime.now().strftime('%Y-%m-%d')}）\n以下是今天搜索获取的最新数据，优先使用：\n{search_data[:4000]}" if search_data else ""
    return SYSTEM_PROMPT.format(user_context=ctx, search_context=sch)

# ═══════════ 分流 ═══════════
def _is_deep(msg: str) -> bool:
    kw = ['深挖','分析','研究','看一下','看看','了解','怎么看','是什么','怎么回事','评估','展开','详细','说说','底层','逻辑','趋势','泡沫','前景','赛道']
    return any(w in msg for w in kw) or bool(re.search(r'(?<!\d)\d{6}(?!\d)', msg))

def _is_followup(msg: str, history: list) -> bool:
    if not history: return False
    fu_kw = ['为什么','什么意思','哪里来的','依据','来源','数据','你说','指的是','这个','那个','解释']
    return any(w in msg for w in fu_kw)

def _is_report_request(msg: str) -> bool:
    """用户主动要求保存/入库/生成报告"""
    rpt_kw = ['生成报告','保存为报告','入库','保存入库','入库保存','形成报告','出一份报告','帮我整理成报告','保存','保存下来']
    return any(w in msg for w in rpt_kw)

def _extract_entities_from_text(text: str) -> list:
    """通用提取：匹配 DS API 输出中的 公司名(6位代码) 模式 —— 全A股通用"""
    found = []
    seen = set()

    # 正则匹配 任意中文公司名(6位数字代码)
    # 例：力诺药包(301188)、宁德时代(300750)
    for m in re.finditer(r'([一-鿿]{2,8})\s*[（(]\s*(\d{6})\s*[）)]', text):
        name = m.group(1)
        code = m.group(2)
        if name not in seen:
            seen.add(name)
            found.append({"name": name, "code": code, "type": "entity"})

    return found

def _gen_card_md(name: str, code: str, card_type: str, summary: str) -> str:
    today = datetime.now().strftime("%Y-%m-%d")
    tag_map = {"entity":"实体, 公司","concept":"概念, 赛道","track":"概念, 赛道"}
    dir_map = {"entity":"实体","concept":"概念","track":"概念"}
    layer_map = {"entity":"L4","concept":"concept","track":"L2"}
    subdir = dir_map.get(card_type, "实体")
    layer = layer_map.get(card_type, "concept")
    return {
        "filename": f"{name}{'·'+code if code else ''}.md",
        "subdir": subdir,
        "content": f"""---
tags: [{tag_map.get(card_type, '概念')}]
domain: [投资]
created: {today}
updated: {today}
layer: {layer}
card_stage: seed
moat_score:
governance_score:
growth_quality:
version: v0.1
status: 草稿
调用次数: 1
数据新鲜度: {today}
置信度: 中
---

# {name}{' ('+code+')' if code else ''}

## 核心发现
{summary[:1500]}

## 来源
深度挖掘 v12.0 · {datetime.now().isoformat()}
"""
    }

# ═══════════ 管道数据格式化 ═══════════

def _parse_csv_to_md_table(csv_path: Path, columns: list, title: str, max_rows: int = 12) -> str:
    """CSV → 干净 Markdown 表格。只保留指定列，格式化为人类可读。"""
    if not csv_path.exists(): return ""
    df = pd.read_csv(csv_path)
    # 只保留存在的列
    cols = [c for c in columns if c in df.columns]
    if not cols: return ""
    df = df[cols].head(max_rows)
    # 数字格式化：去除科学计数法
    for c in cols:
        df[c] = df[c].apply(_fmt_number)
    # 生成 Markdown
    out = f"\n### {title}\n\n"
    out += "| " + " | ".join(cols) + " |\n"
    out += "|" + "|".join(["------"] * len(cols)) + "|\n"
    for _, row in df.iterrows():
        out += "| " + " | ".join(str(v) for v in row) + " |\n"
    return out

def _fmt_number(v):
    """格式化数字：1.2345亿 → 1.23亿，0.1700 → 0.17，NaN → —"""
    if pd.isna(v) or v == "False" or v == "None":
        return "—"
    if isinstance(v, str) and ("亿" in v or "万" in v):
        return v
    try:
        n = float(v)
        if abs(n) >= 1_0000_0000:
            return f"{n/1_0000_0000:.2f}亿"
        elif abs(n) >= 1_0000:
            return f"{n/1_0000:.2f}万"
        elif abs(n) < 0.01:
            return f"{n:.4f}"
        else:
            return f"{n:.2f}"
    except:
        return str(v)

def _build_pipeline_data_block(code: str) -> str:
    """构建完整的管道数据注入块——干净 Markdown 表"""
    csv_dir = DATA_DIR / "financials"
    block = ""

    # 核心指标表
    abstract = csv_dir / f"{code}_财务摘要.csv"
    if abstract.exists():
        block += _parse_csv_to_md_table(abstract, [
            "报告期", "营收(亿)", "营收同比(%)", "净利润(亿)", "净利同比(%)",
            "毛利率(%)", "净利率(%)", "ROE(%)", "资产负债率(%)"
        ], "📊 管道实时数据·核心指标（AKShare）")

    # 季度快照
    snap = csv_dir / f"{code}_季度快照.csv"
    if snap.exists():
        block += _parse_csv_to_md_table(snap, [
            "报告期", "营收(亿)", "营收同比(%)", "净利(亿)", "净利同比(%)",
            "毛利率(%)", "ROE(%)"
        ], "📊 管道实时数据·季度快照（AKShare·最近5期）", max_rows=5)

    if not block:
        return ""

    today_str = datetime.now().strftime("%Y-%m-%d")
    block = (
        f"【系统当前日期：{today_str}】\n"
        f"【数据来源：AKShare 金融数据管道·实时拉取·日期{today_str}】\n"
        f"【⚠️ 以下表格中的数据为真实管道数据，截止{today_str[:4]}年最新披露。请逐行读取表格中的数字用于回答。不得使用训练数据替代。如果表格中的数据与你训练数据不一致，以表格为准】\n\n"
        + block
    )
    return block
async def _run_chat(msg: str, ds_key: str, history: list, user: dict, is_deep: bool):
    name = _extract_entity(msg)
    code = ""
    m = re.search(r'(?<!\d)(\d{6})(?!\d)', msg)
    if m: code = m.group(1)

    yield {"type":"status","text":f"🔍 搜索最新数据..."}

    # 搜索词模板：按消息类型分类
    if code:
        sq = f"{name} {code} 财报 2025 2026 最新 营收 净利润"
    elif any(w in msg for w in ['十五五','规划','政策','行业','赛道','产业','储能','光伏','风电','电网','特高压','半导体','机器人','电池','新能源','AI','算力','氢能','固态']):
        sq = f"{name} 2025 2026 最新 数据 装机 政策"
    else:
        sq = f"{name} 2025 2026 产业化 成本 进展"
    sd = _run_search(sq)
    yield {"type":"status","text":"✅ 数据就绪" if sd else "⚠️ 搜索未返回结果"}

    pipe_block = ""
    log.info(f"管道判断: msg包含code={code}, entity={name}")
    if code:
        yield {"type":"status","text":"📊 拉取财务数据管道..."}
        py = shutil.which("python3") or "python"
        script = PIPELINE_DIR / "fetch_financials.py"
        if not script.exists():
            yield {"type":"status","text":"⚠️ 管道脚本缺失"}
        else:
            try:
                r = subprocess.run([py, str(script), code, "--output-dir", str(DATA_DIR / "financials")], capture_output=True, text=True, timeout=120)
                if r.returncode == 0:
                    pipe_block = _build_pipeline_data_block(code)
                    yield {"type":"status","text":"✅ 财务数据管道就绪" if pipe_block else "⚠️ CSV未生成"}
                else:
                    yield {"type":"status","text":"⚠️ 管道返回错误"}
            except Exception as e:
                yield {"type":"status","text":"⚠️ 管道异常"}

    l1 = _load_user_cards(user)
    sp = _build_system_prompt(l1, sd)
    yield {"type":"status","text":"📝 生成分析..."}

    today_str = datetime.now().strftime('%Y-%m-%d')
    user_msg = f"分析主题：{name}"
    if code: user_msg += f"（{code}）"
    if pipe_block:
        user_msg += f"\n\n{pipe_block}"
    else:
        user_msg += f"\n\n⚠️ 未获取到管道数据。请基于你的训练知识回答，每一个数字标注\"基于内置知识，请用户验证\"。绝对不编造数据。"
    user_msg += f"\n\n用户问题：{msg}"
    if is_deep:
        user_msg += "\n\n这是一个深度分析请求。请用对话的语言给出完整的分析——有背景、有数据、有判断。数字带来源和单位。管道数据优先使用。末尾生成📇知识卡片。"

    import aiohttp
    headers = {"Authorization":f"Bearer {ds_key}","Content-Type":"application/json"}
    messages = [{"role":"system","content":sp}]
    for h in history[-8:]:
        role = h.get("role","user"); content = h.get("content","") or h.get("text","")
        if content: messages.append({"role":"assistant" if role in ("ai","assistant") else "user","content":str(content)[:1500]})
    messages.append({"role":"user","content":user_msg[:80000]})

    full = ""
    async with aiohttp.ClientSession() as sess:
        async with sess.post("https://api.deepseek.com/chat/completions", headers=headers,
            json={"model":"deepseek-chat","messages":messages,"max_tokens":is_deep and 8192 or 4096,"temperature":0.3,"stream":True},
            timeout=aiohttp.ClientTimeout(total=180)) as resp:
            if resp.status != 200:
                err = await resp.text(); yield {"type":"error","text":f"DeepSeek API 错误({resp.status}): {err[:300]}"}; return
            async for line in resp.content:
                line = line.decode("utf-8").strip()
                if line.startswith("data: "):
                    chunk = line[6:]
                    if chunk == "[DONE]": break
                    try:
                        delta = json.loads(chunk).get("choices",[{}])[0].get("delta",{}).get("content","")
                        if delta: full += delta; yield {"type":"text","text":delta}
                    except json.JSONDecodeError: continue

    if not full:
        yield {"type":"error","text":"未收到分析结果"}; return

    # 分离卡片
    card = ""; report = full
    for marker in ["📇 知识卡片", "📇 **知识卡片**", "## 📇"]:
        if marker in full:
            parts = full.split(marker, 1); report = parts[0].strip(); card = marker + parts[1].strip()
            break

    yield {"type":"report","text":report}
    if card: yield {"type":"card","text":card}

    # 提取实体生成额外卡片
    entities = _extract_entities_from_text(report)
    cards_to_write = []
    if card and name:
        cards_to_write.append(_gen_card_md(name, code, "entity", report[:1000]))
    for ent in entities:
        if ent["name"] != name:
            cards_to_write.append(_gen_card_md(ent["name"], ent["code"], ent["type"], report[:800]))

    # 提取 🔑 新概念 生成概念卡（替代硬编码列表——由 DS API 自行判断）
    concept_match = re.search(r'🔑\s*新概念[:：]\s*(.+?)(?:\n|$)', report)
    if concept_match:
        concept_names = re.split(r'[,，、]\s*', concept_match.group(1).strip())
        existing_names = {c["name"] for c in cards_to_write}
        for cname in concept_names:
            cname = cname.strip()
            if cname and cname not in existing_names and len(cname) >= 2:
                existing_names.add(cname)
                cards_to_write.append(_gen_card_md(cname, "", "concept", report[:800]))

    # 按 name 去重——同名卡片只保留第一张
    seen_names = set()
    deduped_cards = []
    for c in cards_to_write:
        if c["name"] not in seen_names:
            seen_names.add(c["name"])
            deduped_cards.append(c)
    cards_to_write = deduped_cards

    if cards_to_write:
        yield {"type":"cards_batch","text":json.dumps(cards_to_write, ensure_ascii=False)}
        yield {"type":"status","text":f"📇 {len(cards_to_write)} 张知识卡片已生成 · 自动写入 Obsidian"}

    # 检查是否触发报告
    h2_count = len(re.findall(r'^## ', report, re.MULTILINE))
    if is_deep and len(report) > 1000 and h2_count >= 3:
        yield {"type":"suggest_report","text":"本次讨论深度足够，要生成A4报告吗？"}

    # 服务器端备份
    reports_file = DATA_DIR / "reports.json"
    reports = json.loads(reports_file.read_text("utf-8")) if reports_file.exists() else []
    m = re.search(r'^(?!#)\s*#\s+(.+)$', report, re.MULTILINE)
    title = m.group(1).strip() if m else name
    reports.insert(0, {"id":uuid.uuid4().hex[:12],"user":user["email"],"title":title,"entity":name,"date":datetime.now().isoformat(),"content":report[:20000],"card":card[:5000]})
    reports_file.write_text(json.dumps(reports[-200:], ensure_ascii=False, indent=2), encoding="utf-8")

def _load_user_cards(user: dict) -> str:
    ob = user.get("obsidian_path","")
    if not ob: return ""
    cards_dir = Path(ob) / "1-原子笔记"
    if not cards_dir.exists(): return ""
    try:
        lines = []
        for f in sorted(cards_dir.rglob("*.md"))[:20]:
            text = f.read_text(encoding="utf-8")[:100]
            title = text.split("\n")[0].replace("# ","").strip()[:50] if text else f.stem
            lines.append(f"- {title}")
        return "\n".join(lines)
    except: return ""

def _extract_entity(msg: str) -> str:
    known = ['钠离子电池','钠电池','钠电','储能','新型储能','十五五','AI算力','人工智能',
             '电力','电力板块','半导体','光伏','新能源','数据中心',
             '机器人','人形机器人','工业机器人',
             '宁德时代','宁德','比亚迪','阳光电源','贵州茅台','茅台','五粮液','五粮',
             '汇川技术','绿的谐波','埃斯顿','容百科技',
             '白酒','电网','特高压','固态电池','液流','氢能',
             '中国西电','西电','特变电工','保变电气','沪电股份','胜宏科技','深南电路']
    for k in sorted(known, key=len, reverse=True):
        if k in msg: return k
    chars = re.findall(r'[一-鿿]{2,}', msg)
    return chars[0] if chars else msg[:25]

# ═══════════ API: 聊天 ═══════════
@app.post("/api/chat")
async def api_chat(req: ChatRequest, user: dict = Depends(_require_user)):
    msg = req.message.strip()
    if not msg: raise HTTPException(400, "消息不能为空")
    ds_key = user.get("ds_key")
    if not ds_key: raise HTTPException(400, "请先在设置中填入 DeepSeek API Key")
    is_deep = _is_deep(msg) and not _is_followup(msg, req.history) and not _is_report_request(msg)
    log.info(f"chat: {user['email']} deep={is_deep} msg={msg[:60]}...")

    async def stream():
        try:
            async for evt in _run_chat(msg, ds_key, req.history, user, is_deep):
                yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
        except Exception as e:
            log.error(f"stream: {e}")
            yield f"data: {json.dumps({'type':'error','text':f'服务器内部错误: {str(e)[:200]}'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                            headers={"X-Accel-Buffering":"no","Cache-Control":"no-cache"})

if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

if __name__ == "__main__":
    import uvicorn; uvicorn.run(app, host="0.0.0.0", port=8000)
