#!/bin/bash
# 深度挖掘商业版 v1.0.0 · 云服务器部署脚本
# 使用方法：在阿里云服务器上执行 bash deploy.sh

set -e
echo "🚀 深度挖掘 v1.0.0 部署中..."

# 1. 备份旧版
if [ -f /home/admin/deepdig/server.py ]; then
    cp /home/admin/deepdig/server.py /home/admin/deepdig/server.py.bak.$(date +%Y%m%d%H%M%S)
    echo "✅ 已备份旧版 server.py"
fi

# 2. 部署新版 server.py
cp server.py /home/admin/deepdig/server.py
echo "✅ 已部署 server.py"

# 3. 部署前端
mkdir -p /home/admin/deepdig/frontend
cp user.html /home/admin/deepdig/frontend/user.html
echo "✅ 已部署 frontend/user.html"

# 4. 重启服务
sudo systemctl restart deepdig
echo "✅ 已重启 deepdig 服务"

# 5. 验证
sleep 2
curl -s http://localhost:8000/api/health | python3 -m json.tool
echo ""
echo "🎉 部署完成。访问 https://deepdig.beaver-cloud.com"
