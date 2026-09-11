---
layout: default
title: Materials
permalink: /materials/
---

Binders, solvents, varnishes, driers, and the layering rules that govern how oil paint actually cures — not just pigment chemistry, but paint *technology*. Sourced from [CAMEO](https://cameo.mfa.org/wiki/Pigment), the Museum of Fine Arts Boston's conservation materials reference (and Wikipedia where noted).

{%- assign materials = site.data.materials_index -%}
{%- assign categories = "binder,solvent,varnish,additive,technique" | split: "," -%}
{%- assign category_labels = "Binders,Solvents,Varnishes,Additives &amp; Driers,Technique" | split: "," -%}

{% for cat in categories %}
  {%- assign label = category_labels[forloop.index0] -%}
  {%- assign group = materials | where: "category", cat -%}
  {% if group.size > 0 %}
<h3>{{ label }}</h3>
<div class="palette-grid">
  {% for m in group %}
  <div class="swatch-card">
    {% if m.hex %}<div class="swatch" style="background-color: {{ m.hex }};"></div>{% endif %}
    <div class="swatch-name">{{ m.name }}</div>
    <div class="swatch-source">{{ m.composition }}</div>
    <div class="swatch-formula">{{ m.drying }}</div>
    <div class="swatch-note">{{ m.note }}</div>
    <a class="swatch-link" href="{{ m.link }}" target="_blank" rel="noopener">{{ m.link_label }} ↗</a>
  </div>
  {% endfor %}
</div>
  {% endif %}
{% endfor %}
