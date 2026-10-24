from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math
W,H=1080,1350
blue=(15,64,138); dark=(8,36,84); orange=(248,154,12); white=(255,255,255)
B='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
def F(s): return ImageFont.truetype(B,s,layout_engine=ImageFont.Layout.RAQM)
# gradient bg
im=Image.new('RGB',(W,H)); px=im.load()
for y in range(H):
    k=y/H
    c=tuple(int(blue[i]*(1-k)+dark[i]*k) for i in range(3))
    for x in range(W): px[x,y]=c
ov=Image.new('RGBA',(W,H),(0,0,0,0)); od=ImageDraw.Draw(ov)
od.ellipse((-250,380,450,1080),fill=(255,255,255,14))
od.ellipse((700,-200,1300,400),fill=(248,154,12,40))
od.ellipse((650,700,1250,1300),fill=(255,255,255,12))
# flight arc + plane
for i in range(0,60,2):
    t=i/60; x=80+t*920; y=330-math.sin(t*math.pi)*90
    od.ellipse((x-4,y-4,x+4,y+4),fill=(255,255,255,90))
t=0.62; px_=80+t*920; py=330-math.sin(t*math.pi)*90
od.polygon([(px_-34,py+8),(px_+40,py-10),(px_-6,py-28),(px_-14,py-8),(px_-44,py-4)],fill=(255,255,255,230))
od.polygon([(px_-14,py-4),(px_+8,py+32),(px_+14,py+30),(px_+6,py-8)],fill=(255,255,255,230))
im=Image.alpha_composite(im.convert('RGBA'),ov).convert('RGB'); d=ImageDraw.Draw(im)
def tx(y,s,size,fill,maxw=940,x=W//2):
    f=F(size)
    while size>28 and d.textlength(s,font=f,direction='rtl',language='ar')>maxw:
        size-=2; f=F(size)
    d.text((x,y),s,font=f,fill=fill,anchor='mm',direction='rtl',language='ar')
# logo card
logo=Image.open('logo.png').convert('RGB'); lw=520; logo=logo.resize((lw,int(logo.height*lw/logo.width)),Image.LANCZOS)
card=(W-lw-60)//2
d.rounded_rectangle((card,40,card+lw+60,40+logo.height+30),radius=34,fill=white)
im.paste(logo,(card+30,55))
# headline
tx(400,'خايف تأشيرتك تترفض؟',84,white)
tx(500,'احنا هنعملهالك بضمان الإصدار',54,(255,214,140))
cx,cy,r=W//2,745,185
d.ellipse((cx-r-10,cy-r-10,cx+r+10,cy+r+10),fill=white)
d.ellipse((cx-r,cy-r,cx+r,cy+r),fill=orange)
tx(cy-100,'تأشيرة الإمارات',40,white,maxw=250)
tx(cy-30,'16500',108,white,maxw=290)
tx(cy+50,'جنيه',44,white,maxw=200)
tx(cy+105,'لمدة شهرين',40,dark,maxw=250)
d.rounded_rectangle((90,960,W-90,1050),radius=34,fill=white)
tx(1005,'الإصدار خلال 48 ساعة',56,blue,maxw=860)
for i,s2 in enumerate(['بضمان الإصدار .. أو فلوسك كاملة','نراجع أوراقك معاك قبل التقديم']):
    y=1100+i*62
    d.ellipse((W-150-24,y-24,W-150+24,y+24),fill=orange)
    d.line([(W-150-11,y),(W-150-2,y+10),(W-150+12,y-9)],fill=white,width=6,joint='curve')
    tx(y,s2,38,white,maxw=720,x=W//2-30)
d.rectangle((0,1215,W,H),fill=orange)
tx(1257,'كلمنا دلوقتي على واتساب',44,dark)
tx(1313,'01021762000',58,white)
im.save('post-uae-16500.png',optimize=True)
