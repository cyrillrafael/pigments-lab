---
layout: default
title: Palette
permalink: /palette/
---

Plant, mineral, and synthetic pigments — swatches are illustrative approximations, not spectrophotometric data. Sourced from [CAMEO](https://cameo.mfa.org/wiki/Pigment), the Museum of Fine Arts Boston's conservation materials reference.

{%- assign pigments = site.data.pigment_index -%}
{%- assign categories = "plant,mineral,synthetic" | split: "," -%}
{%- assign category_labels = "Plant,Mineral,Synthetic" | split: "," -%}

{% for cat in categories %}
  {%- assign label = category_labels[forloop.index0] -%}
  {%- assign group = pigments | where: "category", cat -%}
  {% if group.size > 0 %}
<h3>{{ label }}</h3>
<div class="palette-grid">
  {% for p in group %}
  <div class="swatch-card">
    <div class="swatch" style="background-color: {{ p.hex }};"></div>
    <div class="swatch-name">{{ p.name }}</div>
    <div class="swatch-source">{{ p.source }}</div>
    <div class="swatch-formula">{{ p.formula }}</div>
    <div class="swatch-note">{{ p.note }}</div>
    <a class="swatch-link" href="{{ p.link }}" target="_blank" rel="noopener">{{ p.link_label }} ↗</a>
  </div>
  {% endfor %}
</div>
  {% endif %}
{% endfor %}
