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
tx(430,'تأشيرة السعودية السياحية',74,white)
tx(515,'بضمان الإصدار .. أو فلوسك كاملة',46,(255,214,140))
# price badge
cx,cy,r=W//2,720,150
d.ellipse((cx-r-10,cy-r-10,cx+r+10,cy+r+10),fill=white)
d.ellipse((cx-r,cy-r,cx+r,cy+r),fill=orange)
tx(cy-60,'السعر',40,white,maxw=200)
tx(cy+10,'8500',112,white,maxw=250)
tx(cy+84,'جنيه',44,white,maxw=200)
# conditions
d.rounded_rectangle((90,915,W-90,1005),radius=30,fill=(255,255,255))
tx(960,'الشروط: مؤهل عالي  +  كشف حساب بنكي',44,blue,maxw=880)
for i,s in enumerate(['استرداد كامل لو التأشيرة ماطلعتش','نراجع أوراقك معاك قبل التقديم']):
    y=1065+i*70
    d.ellipse((W-150-27,y-27,W-150+27,y+27),fill=orange)
    d.line([(W-150-13,y),(W-150-3,y+11),(W-150+14,y-10)],fill=white,width=7,joint='curve')
    tx(y,s,40,white,maxw=720,x=W//2-30)
# CTA
d.rectangle((0,1190,W,H),fill=orange)
tx(1240,'الخط الساخن .. اتصل دلوقتي',50,dark)
tx(1305,'01021762000',66,white)
im.save('ad-visa-8500-call.png',optimize=True)
