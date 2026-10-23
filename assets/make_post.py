#!/usr/bin/env python3
"""Branded post/story generator for Al-Naseem Travel.
Usage: python3 assets/make_post.py OUT.png feed|story "HEADLINE" "PILL TEXT" "LINE 1" "LINE 2" ...
Feed = 1080x1350, story = 1080x1920. White background, blue/orange identity, WhatsApp footer."""
import sys, os
from PIL import Image, ImageDraw, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__))
blue=(15,64,138); orange=(248,154,12); white=(255,255,255)
PHONE='01021762000'
FONT='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

def F(s): return ImageFont.truetype(FONT,s,layout_engine=ImageFont.Layout.RAQM)
def fit(d,s,size,maxw):
    while size>30 and d.textlength(s,font=F(size),direction='rtl',language='ar')>maxw: size-=2
    return F(size)
def t(d,W,y,s,size,fill,maxw=940):
    d.text((W//2,y),s,font=fit(d,s,size,maxw),fill=fill,anchor='mm',direction='rtl',language='ar')

def make(out, kind, headline, pill, lines):
    src = Image.open(os.path.join(HERE,'logo.jpg')).convert('RGB').crop((55,215,740,572))
    logo = src.resize((880,int(src.height*880/src.width)), Image.LANCZOS)
    W,H = (1080,1350) if kind=='feed' else (1080,1920)
    top = 50 if kind=='feed' else 330
    im = Image.new('RGB',(W,H),white); d = ImageDraw.Draw(im)
    im.paste(logo,((W-logo.width)//2,top))
    y = top+logo.height+60
    d.line([(140,y),(W-140,y)],fill=orange,width=4)
    y += 85
    t(d,W,y,headline,78,blue); y += 80
    if pill:
        d.rounded_rectangle((130,y,W-130,y+170),radius=40,fill=orange)
        t(d,W,y+88,pill,84,white,maxw=W-300); y += 170
    y += 70
    for i,s in enumerate(lines):
        t(d,W,y,s,52,blue if i%2==0 else orange); y += 85
    foot = 125
    d.rectangle((0,H-foot,W,H),fill=blue)
    t(d,W,H-foot//2,'واتساب: '+PHONE,56,white)
    im.save(out)

if __name__=='__main__':
    out,kind,headline,pill,*lines = sys.argv[1:]
    make(out,kind,headline,pill,lines)
