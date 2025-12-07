// export.js
require('dotenv').config();

const { Client } = require('@notionhq/client');
const { NotionToMarkdown } = require('notion-to-md');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ==== 1. 基础配置：根据你的 11ty 项目目录调整 ====
const OUTPUT_MD_DIR = path.join(__dirname, '../posts');       // 11ty Markdown 目录
const OUTPUT_IMG_DIR = path.join(__dirname, '../img/notion'); // 11ty 图片根目录
const IMG_PUBLIC_PATH = '/img/notion';                        // Markdown 中写图片用的路径前缀

// ==== 2. 初始化 Notion 客户端 ====
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

// 图片根目录，不再固定是 ../img/notion，而是 ../img/<文章名> 这种
const IMG_ROOT_DIR = path.join(__dirname, '../img');
const IMG_ROOT_PUBLIC = '/img';

// 当前正在导出的这篇文章专用的图片目录 & 公网路径前缀
let CURRENT_IMG_DIR = null;
let CURRENT_IMG_PUBLIC_PATH = null;

// 图片计数器，保证同一篇文章里图片文件名不冲突
let imageIndex = 1; // 保证每张图片文件名唯一

async function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// 简单 slug 化：用作文件名
function slugify(text) {
  return text
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[\s\/]+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/\-+/g, '-')
    || 'untitled';
}

// 根据 Notion 标题生成“安全文件名/文件夹名”
// 规则：空格和非法字符全部变成下划线，多余下划线压缩
function safeNameFromTitle(title) {
  return title
    .toString()
    .trim()
    // 先把各种空白变成下划线
    .replace(/\s+/g, '_')
    // 再把 Windows/路径非法字符统统换成下划线
    .replace(/[\\\/:*?"<>|]+/g, '_')
    // 再把连续多个下划线压成一个
    .replace(/_+/g, '_')
    // 全部转为小写
    .toLowerCase()
    || 'untitled';
}

// ==== 3. 下载图片到本地 ====
// ==== 3. 下载图片到本地 ====
async function downloadImage(url, fileName) {
  if (!CURRENT_IMG_DIR || !CURRENT_IMG_PUBLIC_PATH) {
    console.error('CURRENT_IMG_DIR / CURRENT_IMG_PUBLIC_PATH 未初始化');
    return null;
  }

  await ensureDir(CURRENT_IMG_DIR);

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`下载图片失败: ${url} – ${res.status}`);
    return null;
  }

  // 简单猜测后缀名
  const contentType = res.headers.get('content-type') || '';
  let ext = '.jpg';
  if (contentType.includes('png')) ext = '.png';
  if (contentType.includes('gif')) ext = '.gif';
  if (contentType.includes('webp')) ext = '.webp';

  // 每张图片加一个自增编号，避免重名覆盖
  const baseName = slugify(fileName) || 'notion-image';
  const safeName = `${baseName}-${imageIndex++}${ext}`;
  const filePath = path.join(CURRENT_IMG_DIR, safeName);

  const fileStream = fs.createWriteStream(filePath);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on('error', reject);
    fileStream.on('finish', resolve);
  });

  return {
    filePath,
    publicPath: `${CURRENT_IMG_PUBLIC_PATH}/${safeName}`,
  };
}

// ==== 4. 处理 notion-to-md 输出 ====
async function transformMarkdownWithImages(mdBlocks) {
  /**
   * notion-to-md 默认返回类似：
   * [
   *   { parent: '段落内容', children: [] },
   *   { parent: '![caption](image_url)', children: [] },
   *   ...
   * ]
   */
  const lines = [];

  for (const block of mdBlocks) {
    let text = block.parent || '';

    // 找出 Markdown 图片语法：![](url)
    const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;

    let match;
    let lastIndex = 0;
    let newLineParts = [];

    while ((match = imgRegex.exec(text)) !== null) {
      const [full, alt, url] = match;

      // 插入图片前面的普通文字
      newLineParts.push(text.slice(lastIndex, match.index));

      // 下载图片
      try {
        const imgRes = await downloadImage(url, alt || 'notion-image');
        if (imgRes) {
          // 替换为指向本地的路径
          newLineParts.push(`![${alt}](${imgRes.publicPath})`);
        } else {
          // 下载失败就保留原链接
          newLineParts.push(full);
        }
      } catch (e) {
        console.error('处理图片出错：', e);
        newLineParts.push(full);
      }

      lastIndex = match.index + full.length;
    }

    if (lastIndex === 0) {
      // 没有图片直接 push 原 parent
      lines.push(text);
    } else {
      // 加上最后一段普通文字
      newLineParts.push(text.slice(lastIndex));
      lines.push(newLineParts.join(''));
    }

    // 处理子 block（例如列表嵌套等）
    if (block.children && block.children.length > 0) {
      const childMd = await transformMarkdownWithImages(block.children);
      lines.push(childMd);
    }
  }

  return lines.join('\n');
}

// ==== 5. 主流程：导出一个 Notion 页面 ====
async function exportPage(pageId) {
  console.log('开始导出 Notion 页面：', pageId);

  await ensureDir(OUTPUT_MD_DIR);

  // 5.1 拉取页面标题，用于生成文件名、front matter 等
  const page = await notion.pages.retrieve({ page_id: pageId });
  let title = 'Untitled';

  try {
    const titleProp = page.properties?.Name || page.properties?.title;
    if (titleProp && titleProp.title && titleProp.title[0]) {
      title = titleProp.title[0].plain_text || title;
    }
  } catch (e) {
    console.warn('获取标题失败，使用默认标题 Untitled');
  }

  // ✔ 用标题生成“安全名字”：md 文件名 + 图片文件夹都用这个
  const safeTitle = safeNameFromTitle(title);

  // Markdown 文件路径：posts/<Title_xxx>.md
  const outPath = path.join(OUTPUT_MD_DIR, `${safeTitle}.md`);

  // 初始化当前文章的图片目录 & public path
  CURRENT_IMG_DIR = path.join(IMG_ROOT_DIR, safeTitle);        // 比如 img/我的文章标题/
  CURRENT_IMG_PUBLIC_PATH = `${IMG_ROOT_PUBLIC}/${safeTitle}`; // 比如 /img/我的文章标题
  imageIndex = 1; // 每篇文章图片重新从 1 开始计数

  await ensureDir(CURRENT_IMG_DIR);

  // 5.2 notion-to-md 转换
  const mdBlocks = await n2m.pageToMarkdown(pageId);
  // const rawMd = n2m.toMarkdownString(mdBlocks); // 如果你不用 rawMd，可以删掉这行

  // 5.3 处理图片，替换为本地路径
  const finalMdBody = await transformMarkdownWithImages(mdBlocks);

  // 5.4 加一个简单 front matter，适合 11ty
  const frontMatter = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `date: ${new Date().toISOString()}`,
    `tags: [notion]`,
    `slug: ${safeTitle}`,
    '---',
    '',
  ].join('\n');

  const finalContent = frontMatter + finalMdBody;

  fs.writeFileSync(outPath, finalContent, 'utf8');
  console.log('导出完成：', outPath);
}

// ==== 6. 运行入口 ====
(async () => {
  try {
    const pageId = process.env.NOTION_PAGE_ID;
    if (!pageId) {
      console.error('请在 .env 中设置 NOTION_PAGE_ID');
      process.exit(1);
    }

    await exportPage(pageId);
  } catch (e) {
    console.error('导出过程出错：', e);
    process.exit(1);
  }
})();
