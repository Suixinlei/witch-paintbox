"""Read selected Risu card source fields without writing the Risu save."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=Path(__file__).resolve().parents[4].parent / 'risu')
    parser.add_argument('--save', type=Path)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--list', action='store_true')
    group.add_argument('--character', help='Exact card ID or unique name')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--include-trash', action='store_true', help='Include cards deleted into the Risu recycle bin')
    args = parser.parse_args()
    reader_path = args.workspace / '.agents/skills/risu-recent-messages/scripts/recent_messages.py'
    if not reader_path.is_file():
        raise ValueError(f'Risu read-only decoder not found: {reader_path}')
    spec = importlib.util.spec_from_file_location('risu_readonly_decoder', reader_path)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    path = (args.save or reader.find_save(args.workspace)).resolve()
    raw, stat = reader.read_snapshot(path)
    if not raw.startswith(reader.MAGIC):
        raise ValueError('Unsupported save format: expected RISUSAVE header')
    chars = reader.characters(raw, path.parent)
    if not args.include_trash:
        chars = [c for c in chars if not c.get('trashTime')]
    source = dict(save=str(path), modifiedAt=datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                  sha256=hashlib.sha256(raw).hexdigest())
    if args.list:
        result = dict(source=source, cards=[dict(id=c.get('chaId'), name=c.get('name'),
            type=c.get('type', 'character'), coldstorage=bool(c.get('coldstorage')), trashTime=c.get('trashTime'),
            descriptionChars=len(c.get('desc') or ''), loreCount=len(c.get('globalLore') or [])) for c in chars])
    else:
        matches = [c for c in chars if c.get('chaId') == args.character]
        matches = matches or [c for c in chars if c.get('name') == args.character]
        if len(matches) != 1:
            raise ValueError('Card missing or ambiguous; use --list and the exact ID')
        card = matches[0]
        if card.get('coldstorage'):
            raise ValueError('Card is cold-stored; load it in Risu before reading')
        fields = ('chaId', 'name', 'type', 'desc', 'personality', 'scenario', 'firstMessage',
            'exampleMessage', 'alternateGreetings', 'systemPrompt', 'postHistoryInstructions',
            'replaceGlobalNote', 'additionalText', 'notes', 'creatorNotes')
        selected = {key: card[key] for key in fields if key in card}
        selected['globalLore'] = [{key: entry[key] for key in (
            'key', 'secondkey', 'comment', 'content', 'mode', 'alwaysActive', 'disabled',
            'selective', 'useRegex', 'insertorder',
        ) if key in entry} for entry in card.get('globalLore', []) if isinstance(entry, dict)]
        result = dict(format='risu-card-source', version=1, source=source, card=selected)
    output = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        with args.output.open('x', encoding='utf-8') as stream:
            stream.write(output)
        print(json.dumps(dict(file=str(args.output.resolve()), cardId=result.get('card', {}).get('chaId')), ensure_ascii=False))
    else:
        print(output, end='')


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    try:
        main()
    except Exception as error:
        print(json.dumps(dict(error=str(error)), ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
