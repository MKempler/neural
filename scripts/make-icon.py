# Generates web/icon.svg. Usage: python3 scripts/make-icon.py BG INK [LIVE] [--square] > web/icon.svg
# Neural app icon: a side-view brain traced by nodes and links, with one live (green) node.
import sys
args = [a for a in sys.argv[1:] if not a.startswith('--')]
SQUARE = '--square' in sys.argv  # full-bleed background for Android's maskable icon
BG, INK = args[0], args[1]
LIVE = args[2] if len(args) > 2 else '#5fd38d'
# Cerebrum outline, clockwise from the frontal base (front faces left).
O = [(17,54),(17,37),(29,24),(47,17),(66,19),(80,30),(86,46),(77,59),(58,62),(38,63)]
CB = (73,69)          # cerebellum, tucked under the back
STEM = (60,78)        # brainstem
I = [(37,40),(60,36),(52,50)]   # interior; I[0] is the live node
L = [(O[i], O[(i+1) % len(O)]) for i in range(len(O))]
L += [(O[7], CB), (O[8], CB), (O[8], STEM)]
L += [(I[0], O[1]), (I[0], O[3]), (I[0], I[1]), (I[1], O[4]), (I[1], O[6]), (I[0], I[2]), (I[2], O[9]), (I[2], O[7]), (I[1], I[2])]
def svg():
    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">',
           f'<rect width="512" height="512" rx="{0 if SQUARE else 112}" fill="{BG}"/>',
           # brain spans x 17..86, y 17..78 in its own units: centre it in the tile at about 78% width
           '<g transform="translate(-12 9) scale(5.2)">']
    for a, b in L:
        out.append(f'<line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}" stroke="{INK}" stroke-opacity="0.6" stroke-width="2" stroke-linecap="round"/>')
    for p in O + [CB, STEM] + I[1:]:
        out.append(f'<circle cx="{p[0]}" cy="{p[1]}" r="3.5" fill="{INK}"/>')
    out.append(f'<circle cx="{I[0][0]}" cy="{I[0][1]}" r="5.4" fill="{LIVE}"/>')
    out.append('</g></svg>')
    return '\n'.join(out)
print(svg())
