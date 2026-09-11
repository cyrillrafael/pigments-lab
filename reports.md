---
layout: default
title: Reports & Notes
permalink: /reports/
---

Grant reports, accountability documentation, and notes — organized by residency/journey.

{%- assign entries = site.data.reports -%}
{%- assign residencies = site.data.residencies -%}

{% if entries.size == 0 %}
  <p class="empty-note">Nothing uploaded here yet.</p>
{% else %}
  {% for r in residencies %}
    {%- assign group = entries | where: "residency", r.slug | sort: "date" | reverse -%}
    {% if group.size > 0 %}
<h3>{{ r.label }}{% if r.year %} ({{ r.year }}){% endif %}</h3>
<ul>
  {% for e in group %}
  <li>
    <a href="{{ '/reports/' | append: e.file | relative_url }}">{{ e.title | default: e.file }}</a>
    <span class="date">— {{ e.date }}</span>
  </li>
  {% endfor %}
</ul>
    {% endif %}
  {% endfor %}
{% endif %}
