#!/usr/bin/env python3
"""Fail-closed Borsh storage compatibility check for a code-only treasury upgrade."""
import argparse
import re
from pathlib import Path


def extract_body(source: str, declaration: str) -> str:
    match = re.search(declaration, source)
    if not match:
        raise RuntimeError(f"missing declaration: {declaration}")
    opening = source.find("{", match.start())
    if opening < 0:
        raise RuntimeError(f"missing body for declaration: {declaration}")
    depth = 0
    for index in range(opening, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[opening + 1:index]
    raise RuntimeError(f"unterminated declaration: {declaration}")


def struct_fields(source: str, name: str):
    body = extract_body(source, r"pub struct " + re.escape(name) + r"\s*\{")
    fields = []
    for line in body.splitlines():
        value = line.strip()
        if not value or value.startswith("//") or value.startswith("#") or ":" not in value:
            continue
        field, field_type = value.split(":", 1)
        field = field.removeprefix("pub ").strip()
        fields.append((field, field_type.rstrip(",").strip()))
    return fields


def enum_variants(source: str, name: str):
    body = extract_body(source, r"pub enum " + re.escape(name) + r"\s*\{")
    variants = []
    for line in body.splitlines():
        value = line.strip()
        if not value or value.startswith("//") or value.startswith("#"):
            continue
        if value.endswith(","):
            variants.append(value[:-1].strip())
    return variants


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--deployed", required=True)
    parser.add_argument("--candidate", required=True)
    args = parser.parse_args()
    deployed = Path(args.deployed).read_text(encoding="utf-8")
    candidate = Path(args.candidate).read_text(encoding="utf-8")

    for name in ("Veltron", "Commitment", "PendingTransfer"):
        before, after = struct_fields(deployed, name), struct_fields(candidate, name)
        if before != after:
            raise SystemExit(f"FAIL: persisted {name} field layout changed: deployed={before}, candidate={after}")

    old_variants = enum_variants(deployed, "PendingKind")
    new_variants = enum_variants(candidate, "PendingKind")
    if new_variants[:len(old_variants)] != old_variants:
        raise SystemExit("FAIL: existing PendingKind variants changed order or encoding")
    if len(new_variants) <= len(old_variants):
        raise SystemExit("FAIL: candidate PendingKind has no appended variant")
    appended = new_variants[len(old_variants):]
    if appended != ["DiscretionaryRequest { recipient_id: AccountId, memo: Option<String> }"]:
        raise SystemExit(f"FAIL: unexpected appended PendingKind variants: {appended}")

    print("PASS: Veltron state fields, Commitment, and PendingTransfer layouts are unchanged.")
    print("PASS: existing PendingKind variants retain their original order and encoding.")
    print("PASS: only DiscretionaryRequest is appended to PendingKind; no reinitialization is required by this layout change.")


if __name__ == "__main__":
    main()
