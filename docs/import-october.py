#!/usr/bin/env python3
"""Reproduce the faithful, local-only Amil PDF extraction using Poppler and Python stdlib.
Usage: python3 docs/import-october.py SOURCE.pdf [data/import-october.json] [PRIVATE_ALIAS_PAIRS.json]
No OCR, API calls, spelling corrections, or inferred extra shifts.
"""
import collections
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unicodedata
import xml.etree.ElementTree as ET

NS = {'x': 'http://www.w3.org/1999/xhtml'}
DEFINITIONS = {
    'M': {'label': 'Manhã', 'startTime': '07:00', 'endTime': '13:00', 'endDayOffset': 0, 'durationMinutes': 360},
    'T': {'label': 'Tarde', 'startTime': '13:00', 'endTime': '19:00', 'endDayOffset': 0, 'durationMinutes': 360},
    'N': {'label': 'Noite', 'startTime': '19:00', 'endTime': '00:00', 'endDayOffset': 1, 'durationMinutes': 300},
    'D': {'label': 'Madrugada', 'startTime': '00:00', 'endTime': '07:00', 'endDayOffset': 0, 'durationMinutes': 420},
}
WEEKDAYS = ['SEGUNDA', 'TERÇA', 'QUARTA', 'QUINTA', 'SEXTA', 'SÁBADO', 'DOMINGO']

def normalized(value):
    return ' '.join(''.join(c for c in unicodedata.normalize('NFKD', value) if not unicodedata.combining(c)).casefold().split())

def display_name(value):
    small = {'de', 'da', 'do', 'das', 'dos', 'e'}
    return ' '.join(part.lower() if part.lower() in small else ('d\'Alva' if part.lower() == 'd\'alva' else part.capitalize()) for part in value.split())

def extract(source):
    with tempfile.TemporaryDirectory(prefix='amil-pdf-') as temp:
        xmlpath = Path(temp) / 'bbox.html'
        subprocess.run(['pdftotext', '-bbox-layout', str(source), str(xmlpath)], check=True)
        root = ET.parse(xmlpath).getroot()
    pages = root.findall('.//x:page', NS)
    title = root.find('x:head/x:title', NS).text.strip()
    shifts, sections, unknown = [], [], []
    current = None
    previous = {}
    for page_num, page in enumerate(pages, 1):
        lines = sorted(page.findall('.//x:line', NS), key=lambda line: (float(line.attrib['yMin']), float(line.attrib['xMin'])))
        for line in lines:
            text = ' '.join(word.text for word in line.findall('x:word', NS))
            box = [round(float(line.attrib[key]), 3) for key in ['xMin', 'yMin', 'xMax', 'yMax']]
            column = 'left' if box[0] < 306 else 'right'
            header = re.fullmatch(r'(\d{2}/\d{2}/\d{4}) - (SEGUNDA|TERÇA|QUARTA|QUINTA|SEXTA|SÁBADO|DOMINGO) (MT|NOITE|MADRUGADA|REFORÇO)', text)
            if header:
                date = dt.datetime.strptime(header[1], '%d/%m/%Y').date()
                if WEEKDAYS[date.weekday()] != header[2]:
                    raise ValueError(f'Calendar mismatch: {text}')
                current = {'date': date.isoformat(), 'weekday': header[2], 'label': header[3], 'page': page_num, 'rawHeader': text}
                sections.append(current.copy())
                previous = {}
                continue
            if re.match(r'^(ESCALA|Manhã -|Noite -)', text):
                continue
            match = re.fullmatch(r'([MTN]) (.+)', text)
            dawn = re.fullmatch(r'00 as 07h (.+)', text)
            if match or dawn:
                if not current:
                    raise ValueError(f'Shift before date: {page_num}: {text}')
                code, name = (match[1], match[2]) if match else ('D', dawn[1])
                record = {
                    'id': f'oct2026-{len(shifts)+1:04d}',
                    'date': current['date'], 'code': code,
                    **{key: value for key, value in DEFINITIONS[code].items() if key != 'label'},
                    'source': {'page': page_num, 'column': column, 'section': current['label'], 'sectionHeader': current['rawHeader'], 'rawName': name, 'rawLines': [text], 'bbox': [box]},
                    'reviewRequired': False, 'issues': [],
                }
                shifts.append(record)
                previous[column] = record
            elif text.strip():
                # All unprefixed schedule text consists of visibly wrapped surnames.
                if text not in {'Macedo', 'Junior', 'FERNANDES'} or column not in previous:
                    unknown.append({'page': page_num, 'text': text, 'bbox': box})
                    continue
                prev = previous[column]
                prev['source']['rawName'] += ' ' + text
                prev['source']['rawLines'].append(text)
                prev['source']['bbox'].append(box)
    if unknown:
        raise ValueError(f'Unclassified PDF lines: {unknown}')
    doctors, by_key = [], {}
    for shift in shifts:
        raw_name = shift['source']['rawName']
        key = normalized(raw_name)
        if key not in by_key:
            doctor = {'id': f'doc-{len(doctors)+1:03d}', 'name': display_name(raw_name), 'sourceNames': [], 'reviewRequired': False, 'issues': []}
            by_key[key] = doctor
            doctors.append(doctor)
        doctor = by_key[key]
        if raw_name not in doctor['sourceNames']:
            doctor['sourceNames'].append(raw_name)
        shift.update({'doctorId': doctor['id'], 'doctorName': doctor['name']})
    uncertainties = [{
        'id': 'weekend-reinforcement', 'type': 'section-meaning',
        'description': 'As seções REFORÇO de sábados/domingos usam prefixo N. Atribuiu-se 19:00-00:00 pela legenda Noite da página 1; confirmar se REFORÇO tem horário operacional distinto.',
        'requiresHumanReview': True,
    }]
    for shift in shifts:
        if shift['source']['section'] == 'REFORÇO':
            shift['reviewRequired'] = True
            shift['issues'].append('weekend-reinforcement')
    # These spellings can refer to the same person, but the PDF supplies no unique medical identifier.
    # Reviewed name pairs are private source data, never embedded in this script.
    alias_path = Path(sys.argv[3]) if len(sys.argv) > 3 else Path('private/pdf-aliases.json')
    aliases = json.loads(alias_path.read_text()) if alias_path.exists() else []
    for index, names in enumerate(aliases, 1):
        ids = [by_key[normalized(name)]['id'] for name in names]
        issue_id = f'possible-name-alias-{index}'
        uncertainties.append({'id': issue_id, 'type': 'possible-name-alias', 'doctorIds': ids, 'sourceNames': list(names), 'description': 'Possível identidade duplicada por variante de grafia/nome incompleto. Registros mantidos separados; o PDF não informa CRM ou outro identificador.', 'requiresHumanReview': True})
        for doctor_id in ids:
            doctor = next(doctor for doctor in doctors if doctor['id'] == doctor_id)
            doctor['reviewRequired'] = True
            doctor['issues'].append(issue_id)
    anomaly_id = 'oct14-night-staffing'
    uncertainties.append({'id': anomaly_id, 'type': 'source-staffing-anomaly', 'date': '2026-10-14', 'code': 'N', 'sourcePage': 13, 'description': 'A seção de quarta-feira 14/10 à noite contém apenas 4 nomes e coluna direita vazia; as demais quartas têm 8. Preservado como consta, sem inferir os 4 ausentes.', 'requiresHumanReview': True})
    for shift in shifts:
        if shift['date'] == '2026-10-14' and shift['code'] == 'N':
            shift['reviewRequired'] = True
            shift['issues'].append(anomaly_id)
    grouped = collections.defaultdict(list)
    for shift in shifts:
        grouped[(shift['doctorId'], shift['date'], shift['code'])].append(shift)
    duplicate_groups = []
    for key, items in grouped.items():
        if len(items) < 2:
            continue
        issue_id = f'duplicate-assignment-{len(duplicate_groups)+1}'
        issue = {'id': issue_id, 'type': 'duplicate-assignment', 'doctorId': key[0], 'date': key[1], 'code': key[2], 'shiftIds': [item['id'] for item in items], 'description': 'O PDF repete a mesma pessoa no mesmo dia/turno. Preservadas todas as linhas; não contar como vagas independentes sem revisão.', 'requiresHumanReview': True}
        uncertainties.append(issue)
        duplicate_groups.append(issue)
        for item in items:
            item['reviewRequired'] = True
            item['issues'].append(issue_id)
    dates = sorted({shift['date'] for shift in shifts})
    if dates != [f'2026-10-{day:02d}' for day in range(1, 32)]:
        raise ValueError('Not all 31 October dates were extracted')
    if collections.Counter(section['label'] for section in sections) != {'MT':31, 'NOITE':22, 'MADRUGADA':9, 'REFORÇO':9}:
        raise ValueError('Unexpected section coverage')
    return {
        'schemaVersion': 1,
        'source': {'path': str(source.resolve()), 'filename': source.name, 'title': title, 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'pageCount': len(pages), 'month': '2026-10', 'yearEvidence': 'Ano 2026 explícito no cabeçalho e nas 71 seções; todos os dias da semana conferem com o calendário gregoriano.', 'timezone': None, 'timezoneNote': 'O PDF não declara fuso horário.', 'extractionMethod': 'Poppler pdftotext -bbox-layout; reconstrução por coluna, cabeçalho/data e linhas de continuação; inspeção visual das 28 páginas.', 'legendPage': 1},
        'shiftDefinitions': DEFINITIONS,
        'doctors': doctors, 'shifts': shifts, 'sections': sections, 'uncertainties': uncertainties,
        'summary': {'doctors': len(doctors), 'sourceAssignments': len(shifts), 'distinctDoctorDateShiftAssignments': len(grouped), 'duplicateGroups': len(duplicate_groups), 'duplicateExtraRows': len(shifts)-len(grouped), 'shiftCounts': dict(collections.Counter(shift['code'] for shift in shifts)), 'dateCount': len(dates), 'sectionCount':len(sections), 'wrappedNameRows': sum(len(shift['source']['rawLines'])>1 for shift in shifts)},
        'importPolicy': {'privateServerDataOnly': True, 'preserveSourceRows': True, 'autoMergeSpellingVariants': False, 'publishUnreviewedReinforcement': False, 'deduplicateForAvailabilityOnly': True, 'needsHumanIdentityReview': True},
    }

if __name__ == '__main__':
    if len(sys.argv) not in {2, 3, 4}:
        raise SystemExit(__doc__)
    source = Path(sys.argv[1])
    destination = Path(sys.argv[2]) if len(sys.argv) >= 3 else Path('data/import-october.json')
    result = extract(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result['summary'], ensure_ascii=False, indent=2))
