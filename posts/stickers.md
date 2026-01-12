---
title: stickers
description: 
layout: layouts/post.njk
---

<div class="stickers">
  <div class="sticker">
    <p>Hello world</p>
  </div>
</div>

<style>
  .stickers {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding: 8px 0;
  }
  .sticker {
    background: #fff6a6;
    border: 2px solid #1f1f1f;
    box-shadow: 6px 6px 0 #1f1f1f;
    padding: 16px 18px;
    transform: rotate(-1deg);
    max-width: 260px;
  }
  .sticker p {
    margin: 0;
    font-weight: 600;
  }
</style>
