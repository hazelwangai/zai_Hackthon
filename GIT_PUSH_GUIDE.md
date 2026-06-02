# 推送到 GitHub 指南

目标仓库：`https://github.com/hazelwangai/zai_Hackthon.git`

> 以下命令在**你自己的 Mac 终端**里执行（Terminal）。先解压本项目，`cd` 进文件夹。

---

## 0. 准备（只需一次）

```bash
# 检查是否有 git（macOS 通常自带；没有会弹出安装提示，点安装即可）
git --version

# 配置你的身份（换成你的名字和 GitHub 邮箱）
git config --global user.name  "Hazel Wang"
git config --global user.email "你的GitHub邮箱@example.com"
```

进入项目目录（按你解压的位置改路径）：

```bash
cd ~/Downloads/apikey-dispenser
```

初始化并提交：

```bash
git init
git add .
git commit -m "init: API key dispenser with admin panel"
git branch -M main
```

> 说明：`.gitignore` 已默认排除 `keys.json`（真实 Key）和 `.env`，不会被推上去。

---

## 方式 A：HTTPS + Personal Access Token（推荐，新电脑最快）

### A1. 生成 Token
1. 浏览器打开 https://github.com/settings/tokens
2. 选 **Generate new token → Fine-grained token**（或 classic）
3. 勾选对 `zai_Hackthon` 仓库的 **Contents: Read and write** 权限
4. 生成后**复制那串 token**（只显示一次）

### A2. 推送
```bash
git remote add origin https://github.com/hazelwangai/zai_Hackthon.git
git push -u origin main
```
- 提示 **Username**：填你的 GitHub 用户名 `hazelwangai`
- 提示 **Password**：**粘贴刚才的 token**（不是你的登录密码）

> 让 Mac 记住 token，免得每次输入：
> ```bash
> git config --global credential.helper osxkeychain
> ```

---

## 方式 B：SSH 密钥

### B1. 在你本机生成密钥（私钥只留在本机，切勿外传）
```bash
ssh-keygen -t ed25519 -C "你的GitHub邮箱@example.com"
# 一路回车即可（默认路径 ~/.ssh/id_ed25519，密码可留空）

# 启动 agent 并加入密钥
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519

# 复制公钥到剪贴板
pbcopy < ~/.ssh/id_ed25519.pub
```

### B2. 把公钥加到 GitHub
1. 打开 https://github.com/settings/keys
2. **New SSH key** → Title 随便填 → Key 里**粘贴**（已在剪贴板）→ Add

### B3. 测试并推送
```bash
ssh -T git@github.com        # 第一次问 yes，回车；看到 "Hi hazelwangai" 即成功

git remote add origin git@github.com:hazelwangai/zai_Hackthon.git
git push -u origin main
```

> 如果之前已用 HTTPS 加过 origin，先改地址：
> ```bash
> git remote set-url origin git@github.com:hazelwangai/zai_Hackthon.git
> ```

---

## 关于 keys.json（真实 Key）

默认**不会**被推上去。三种选择：

1. **保持现状（推荐）**：Key 不进仓库，部署后在管理后台 `/admin` 手动添加，或把 keys.json 单独传到 Zeabur。
2. **仓库设 Private 且想连 Key 一起推**：删掉 `.gitignore` 里的 `keys.json` 那一行，再 `git add keys.json && git commit && git push`。
3. 用 `keys.example.json` 作为格式参考（这个会进仓库，里面是假数据）。

> ⚠️ 不要把真实 Key 推到 Public 仓库。若不慎推了，光删文件不够——要把 Token/Key 作废重发，因为 Git 历史里仍在。

---

## 推完之后

- 仓库里就有全部代码（不含真实 Key 与 .env）。
- 去 Zeabur 用「Git 服务」指向这个仓库部署，按 README 设环境变量即可。
- 以后改了代码：`git add . && git commit -m "..." && git push`，Zeabur 会自动重新部署。
