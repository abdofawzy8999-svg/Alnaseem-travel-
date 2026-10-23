from PIL import Image, ImageDraw, ImageFont
W,H=1080,1350
blue=(15,64,138); dark=(8,36,84); orange=(248,154,12); white=(255,255,255); soft=(238,243,250)
B='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
def F(s): return ImageFont.truetype(B,s,layout_engine=ImageFont.Layout.RAQM)
logo0=Image.open('logo.png').convert('RGB')
def mk(bg):
    im=Image.new('RGB',(W,H),bg); return im,ImageDraw.Draw(im)
def tx(d,y,s,size,fill,maxw=940,x=W//2):
    f=F(size)
    while size>28 and d.textlength(s,font=f,direction='rtl',language='ar')>maxw:
        size-=2; f=F(size)
    d.text((x,y),s,font=f,fill=fill,anchor='mm',direction='rtl',language='ar')
def logo(im,d,w,y,card=None):
    l=logo0.resize((w,int(logo0.height*w/logo0.width)),Image.LANCZOS)
    if card: d.rounded_rectangle(((W-w)//2-30,y-15,(W+w)//2+30,y+l.height+15),radius=30,fill=white)
    im.paste(l,((W-w)//2,y)); return l.height
def cta(d,top=1215):
    d.rectangle((0,top,W,H),fill=orange)
    tx(d,top+42,'كلمنا دلوقتي: واتساب / اتصال',44,dark)
    tx(d,top+100,'01021762000',60,white)
def check(d,x,y):
    d.ellipse((x-27,y-27,x+27,y+27),fill=orange)
    d.line([(x-13,y),(x-3,y+11),(x+14,y-10)],fill=white,width=7,joint='curve')

# A: guarantee (white, clean)
im,d=mk(white); logo(im,d,560,40)
d.rounded_rectangle((70,470,W-70,1120),radius=50,fill=soft)
cx,cy=W//2,640
d.ellipse((cx-110,cy-110,cx+110,cy+110),fill=blue)
d.line([(cx-50,cy+5),(cx-12,cy+45),(cx+55,cy-40)],fill=white,width=22,joint='curve')
tx(d,820,'فلوسك في أمان',88,blue)
tx(d,925,'لو التأشيرة ماطلعتش..',58,dark)
tx(d,1000,'تاخد فلوسك كاملة',70,orange)
tx(d,1075,'تأشيرة السعودية السياحية بـ 8500 جنيه',40,blue,maxw=860)
cta(d); im.save('ad-v-guarantee.png',optimize=True)

# B: simple conditions (blue)
im,d=mk(blue); logo(im,d,520,40,card=True)
tx(d,400,'تأشيرة السعودية السياحية',70,white)
tx(d,490,'شرطين بس .. وخلاص',54,(255,214,140))
for i,(a,b) in enumerate([('مؤهل عالي','الشرط الأول'),('كشف حساب بنكي','الشرط التاني')]):
    y=640+i*170
    d.rounded_rectangle((90,y-65,W-90,y+65),radius=36,fill=white)
    d.ellipse((W-210,y-48,W-114,y+48),fill=orange); tx(d,y,str(i+1),64,white,maxw=80,x=W-162)
    tx(d,y-22,a,56,blue,maxw=640,x=W//2-50); tx(d,y+34,b,32,(90,110,150),maxw=400,x=W//2-50)
d.rounded_rectangle((90,975,W-90,1135),radius=36,fill=orange)
tx(d,1030,'8500 جنيه',70,white,maxw=700)
tx(d,1096,'بضمان الإصدار .. أو فلوسك كاملة',38,dark,maxw=800)
cta(d); im.save('ad-v-conditions.png',optimize=True)

# C: hook (orange)
im,d=mk(orange); logo(im,d,520,40,card=True)
d.ellipse((-200,700,380,1280),fill=(255,255,255,0) if False else (252,176,64))
d.ellipse((700,380,1260,940),fill=(252,176,64))
tx(d,480,'مسافر السعودية؟',104,white)
tx(d,600,'خلّي التأشيرة علينا',80,dark)
d.rounded_rectangle((120,700,W-120,930),radius=60,fill=white)
tx(d,775,'تأشيرة سياحية بـ',50,blue,maxw=700)
tx(d,860,'8500 جنيه',100,orange,maxw=760)
tx(d,1010,'بضمان الإصدار ✔  مؤهل عالي + كشف حساب',40,dark,maxw=900)
tx(d,1100,'نراجع أوراقك معاك قبل التقديم',44,white,maxw=900)
d.rectangle((0,1215,W,H),fill=blue)
tx(d,1257,'كلمنا دلوقتي: واتساب / اتصال',44,white)
tx(d,1315,'01021762000',60,(255,214,140))
im.save('ad-v-hook.png',optimize=True)
