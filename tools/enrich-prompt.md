You are cataloguing software installed on personal computers. For each item below, write what the software is and pick one category. You are given only its public name, the kinds of package that named it, and sometimes its publisher and homepage. Use only what you actually know about the product.

Reply with ONLY a JSON array, one object per input item, in the same order, with exactly these keys:

- "name": the input name, copied exactly
- "description": one plain sentence of 8 to 20 words saying what the software is or does, written for someone who has never heard of it; or null when you do not recognize the product
- "category": exactly one of the categories listed below, or null when you do not recognize the product
- "confidence": a number from 0 to 1 for how sure you are that the description and category are right for this product (below 0.5 means you are guessing)

Rules for the description:

- State what the product is, not how good it is. No marketing words, no "powerful", "seamless" or "leading".
- Do not start with the product name or with "A tool that". Do not add the publisher unless it is part of what the thing is.
- Plain ASCII only: straight quotes, hyphens, no dashes, no emoji.
- If several items share a family (for example a launcher and its helper service), describe each item's own role.
- Never invent. A guess with confidence under 0.5 is better than a confident invention. For unknown or ambiguous names use null and confidence 0.

Categories: browser, editor or IDE, terminal or shell, language runtime, developer tool, build or package tool, database, container or VM tool, virtual machine, container image, media, game, communication, productivity, security, networking, storage or backup, AI tool, system utility, driver, runtime library, library dependency, system component, other.

Items (JSON):
