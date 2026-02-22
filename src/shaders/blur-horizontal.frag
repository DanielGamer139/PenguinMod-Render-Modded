precision mediump float;
varying vec2 v_texcoord;
uniform sampler2D u_texture;
uniform float u_texelSizeX;

void main() {
    vec4 c = vec4(0.0);
    c += texture2D(u_texture, v_texcoord + vec2(-2.0 * u_texelSizeX, 0.0)) * 0.07027;
    c += texture2D(u_texture, v_texcoord + vec2(-1.0 * u_texelSizeX, 0.0)) * 0.31621;
    c += texture2D(u_texture, v_texcoord) * 0.22702;
    c += texture2D(u_texture, v_texcoord + vec2(1.0 * u_texelSizeX, 0.0)) * 0.31621;
    c += texture2D(u_texture, v_texcoord + vec2(2.0 * u_texelSizeX, 0.0)) * 0.07027;
    gl_FragColor = c;
}
