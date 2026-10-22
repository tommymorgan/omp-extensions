#!/usr/bin/env python3
"""Render preserved real terminal screens, never reconstruct UI from fixture values.
Optional evidence dependencies: pyte, Pillow. Standard-library feature gate is independent.
"""
import argparse,json,pathlib,pyte
from PIL import Image,ImageDraw,ImageFont
p=argparse.ArgumentParser();p.add_argument('directory');a=p.parse_args();root=pathlib.Path(a.directory)
font=ImageFont.truetype('/usr/share/fonts/noto/NotoSansMono-Regular.ttf',16)
emoji=ImageFont.truetype('/usr/share/fonts/noto/NotoColorEmoji.ttf',109)
colors={'default':'#dedede','black':'#111318','red':'#ed8796','green':'#a6da95','brown':'#eed49f','blue':'#8aadf4','magenta':'#c6a0f6','cyan':'#8bd5ca','white':'#dedede','brightblack':'#6e738d'}
results=[]
for capture in sorted(root.glob('*-*.pty')):
 width=int(capture.name.split('-')[0]);screen=pyte.Screen(width,40);pyte.Stream(screen).feed(capture.read_bytes().decode(errors='replace'))
 text='\n'.join(screen.display);capture.with_suffix('.screen.txt').write_text(text)
 image=Image.new('RGB',(width*10+24,40*22+24),'#111318');draw=ImageDraw.Draw(image)
 for y,row in screen.buffer.items():
  for x,cell in row.items():
   if not cell.data:continue
   color=colors.get(cell.fg,'#'+cell.fg if len(cell.fg)==6 else '#dedede')
   if cell.data in ['🧭','💰']:
    tile=Image.new('RGBA',(140,140));ImageDraw.Draw(tile).text((0,0),cell.data,font=emoji,embedded_color=True);tile=tile.resize((23,23));image.paste(tile,(12+x*10,10+y*22),tile)
   else:draw.text((12+x*10,10+y*22),cell.data,font=font,fill=color)
 target=capture.with_suffix('.png');image.save(target)
 results.append({'capture':str(capture),'image':str(target),'screen':str(capture.with_suffix('.screen.txt')),'columns':width})
(root/'visual-evidence.json').write_text(json.dumps(results,indent=2));print(json.dumps({'screens':len(results),'evidence':str(root/'visual-evidence.json')}))
