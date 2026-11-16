import { EventEmitter } from "node:events";
import dgram from "node:dgram";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discover, parseAnnouncement } from "../tools/bambu/discover";
vi.mock("node:dgram",()=>({default:{createSocket:vi.fn<typeof dgram.createSocket>()}}));
const packet="NOTIFY * HTTP/1.1\r\nNT: urn:bambulab-com:device:3dprinter:1\r\nUSN: SYNTHETIC-SERIAL\r\nLocation: 192.0.2.99\r\nDevModel.bambu.com: O1C\r\nDevName.bambu.com: Synthetic printer\r\n\r\n";
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe("SSDP recorded-format synthetic announcements (no printer contact)",()=>{
  it("uses transport address and retains claimed address as untrusted metadata",()=>{
    expect(parseAnnouncement(packet,"192.0.2.1")).toMatchObject({host:"192.0.2.1",claimedHost:"192.0.2.99",serial:"SYNTHETIC-SERIAL",model:"O1C",name:"Synthetic printer"});
    expect(parseAnnouncement(packet.replace("192.0.2.99","192.0.2.1"),"192.0.2.1")?.claimedHost).toBeUndefined();
    expect(parseAnnouncement("HTTP/1.1 200 OK\nST: bambu\n","192.0.2.1")?.host).toBe("192.0.2.1");
    expect(parseAnnouncement("M-SEARCH * HTTP/1.1\nDevVersion.bambu.com: 01\n","192.0.2.1")?.version).toBe("01");
    for(const x of ["", "NOTIFYevil\nNT: bambu", "HTTP/1.1 2000\nNT: bambu", "NOTIFY * HTTP/1.1\nNT: other"])
      expect(parseAnnouncement(x,"192.0.2.1")).toBeUndefined();
  });
  it("bounds duration before opening any sockets",async()=>{
    for(const seconds of [0,-1,NaN,Infinity,61])await expect(discover(seconds)).rejects.toThrow(/duration/);
    expect(dgram.createSocket).not.toHaveBeenCalled();
  });
  it("listens only, deduplicates both ports, tolerates malformed packets and closes sockets",async()=>{
    vi.useFakeTimers();
    const sockets: (EventEmitter & {close:ReturnType<typeof vi.fn>;bind:ReturnType<typeof vi.fn>;addMembership:ReturnType<typeof vi.fn>})[]=[];
    vi.mocked(dgram.createSocket).mockImplementation((()=>{
      const s=Object.assign(new EventEmitter(),{close:vi.fn<() => void>(),bind:vi.fn<(_p:number,cb:()=>void)=>void>((_p,cb)=>cb()),addMembership:vi.fn<() => void>()});sockets.push(s);return s;
    }) as unknown as typeof dgram.createSocket);
    const onFound=vi.fn<() => void>();const result=discover(1,onFound);
    expect(sockets.map(x=>x.bind.mock.calls[0]![0])).toEqual([2021,1990]);
    sockets[0]!.emit("message",Buffer.from("invalid"),{address:"192.0.2.1"});
    for(const s of sockets)s.emit("message",Buffer.from(packet),{address:"192.0.2.1"});
    sockets[1]!.emit("message",Buffer.from("NOTIFY * HTTP/1.1\nNT: bambu\n"),{address:"192.0.2.2"});
    sockets[0]!.emit("error",new Error("synthetic bind failure"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toHaveLength(2);expect(onFound).toHaveBeenCalledTimes(2);
    for(const s of sockets){expect(s.close).toHaveBeenCalled();expect(s.addMembership).toHaveBeenCalledWith("239.255.255.250");}
  });
  it("tolerates unavailable multicast and already-closed socket errors",async()=>{
    vi.useFakeTimers();
    vi.mocked(dgram.createSocket).mockImplementation((()=>Object.assign(new EventEmitter(),{
      bind:(_p:number,cb:()=>void)=>cb(),addMembership:()=>{throw new Error("no multicast");},close:()=>{throw new Error("closed");},
    })) as unknown as typeof dgram.createSocket);
    const r=discover(.1);await vi.advanceTimersByTimeAsync(100);expect(await r).toEqual([]);
  });
});
