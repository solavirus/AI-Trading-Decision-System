# Quant Decision System

Architecture

Version 1.0

Status: Frozen

---

# One Sentence

This is not a trading terminal.

This is a Decision Operating System.

---

# Core Idea

Traditional products help users access data.

This product helps users continuously improve their decision model.

The product does not compete on data.

The product competes on learning.

---

# Product Loop

External Data

↓

Research Input

↓

Decision Weight Model

↓

AI Strategy

↓

Execution

↓

Trade Result

↓

Learning

↓

Weight Update

↓

Next Trade

---

# Core Object

Trade Experiment

Every trade is an experiment.

The experiment records

- Inputs
- Weight
- Strategy
- Execution
- Result

The system continuously learns from these experiments.

---

# Why Dashboard Exists

Dashboard is NOT an AI page.

Dashboard exists to expose all available data sources.

Research will consume these data sources.

---

# Why Research Exists

Research does not analyze.

Research configures.

It defines

- Inputs
- Weight
- Additional Evidence

---

# Why Strategy Exists

Strategy is the ONLY page where AI generates output.

Every other page prepares or records.

---

# Why Execution Exists

Execution separates

AI Recommendation

from

Human Decision.

This distinction is critical for future learning.

---

# Why Trade List Exists

Execution does not immediately produce a result.

Trades may remain open for hours or weeks.

Trade List manages the lifecycle of every experiment.

---

# Why Trade Detail Exists

Trade Detail preserves the complete history of a trade.

Nothing should be regenerated.

History is immutable.

---

# Future

Learning

↓

Weight Optimization

↓

Decision Model Evolution

This is the real moat of the product.

Not AI.

Not market data.

Decision evolution.

---

# Addendum — Analysis Snapshot Integrity (2026-08-07)

This section does not modify the frozen content above. It refines one link of the Product Loop:

External Data ↓ Research Input

A Frozen Product Decision — Analysis Snapshot Integrity, recorded in full in `product-docs/PRODUCT_STATUS.md` — now governs exactly how "External Data" reaches "Research Input" for a given Trade Experiment: collected fresh only after the user starts the analysis, never reused from Dashboard's independent real-time cache; only sources with configured weight greater than zero; any required-source failure cancels the analysis rather than degrading silently; the successful result is frozen once, immediately, as one immutable Analysis Payload.

This directly reinforces the Core Object: every Trade Experiment's "Inputs" are now defined as that one frozen snapshot, not a live, mutable read of whatever Dashboard happens to be showing at query time. Same snapshot → same Prompt → same AI request, always — this is what makes an experiment actually reproducible, not just recorded.

Documentation only — no code has been changed by this addendum, and no part of the Product Loop, Core Object, or the "Why X Exists" sections above is redefined. See `product-docs/PRODUCT_STATUS.md`'s "Analysis Lifecycle" section for the full decision text, and `PROJECT.md` for current implementation status.